"""TikTok-style REST API endpoints.

Mirrors tiktok-api-dl (Bun) endpoints:
  POST /tiktok         - fetch video/photo info, return download links
  GET  /tiktok/download - stream video/image/mp3/slideshow via session key

Production hardening:
- Singleton HybridCrawler (no connection pool leak)
- asyncio.wait_for timeout on extraction (120s)
- hmac.compare_digest for API key (no timing attack)
- Concurrency limiter (semaphore) for extraction + slideshow
- Response cache (TTL 60s) for identical repeated requests
- Slideshow streamed from file (O(1) memory, no full MP4 in RAM)
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from server import response_cache
from server import session as session_store
from server import extraction_cache
from server.crawler_pool import close_crawler, get_crawler
from server.slideshow import (
    SlideshowError,
    cleanup_temp,
    open_file_stream,
    render_slideshow,
)

logger = logging.getLogger("gateway.tiktok")

BUFFER_SIZE = 256 * 1024
EXTRACTION_TIMEOUT_SECONDS = 120
MAX_CONCURRENT_EXTRACTIONS = 8
MAX_CONCURRENT_SLIDESHOW = 2

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, X-API-Key",
}

CDN_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Referer": "https://www.tiktok.com/",
}

EXTRACT_SOURCE = "web"
TIKTOK_API_KEY = os.environ.get("TIKTOK_API_KEY", "")

_extraction_semaphore = asyncio.Semaphore(MAX_CONCURRENT_EXTRACTIONS)
_slideshow_semaphore = asyncio.Semaphore(MAX_CONCURRENT_SLIDESHOW)


class TikTokRequest(BaseModel):
    url: Optional[str] = None
    version: Optional[str] = None
    proxy: Optional[str] = None
    impersonate: Optional[str] = None


# ---------- Helpers ----------


def _json_response(body: Any, status: int = 200, extra: Optional[dict] = None) -> Response:
    headers = {"Content-Type": "application/json; charset=utf-8", **CORS_HEADERS}
    if extra:
        headers.update(extra)
    return Response(content=json.dumps(body), media_type="application/json", status_code=status, headers=headers)


def _error_json(message: str, status: int = 500, code: Optional[str] = None) -> Response:
    body: Dict[str, str] = {"error": message}
    if code:
        body["code"] = code
    return _json_response(body, status)


def _check_api_key(request: Request) -> bool:
    if not TIKTOK_API_KEY:
        return True
    key = request.headers.get("X-API-Key") or request.query_params.get("api_key") or ""
    return hmac.compare_digest(key, TIKTOK_API_KEY)


def _detect_platform(url: str) -> str:
    if "douyin" in url:
        return "douyin"
    if "tiktok" in url:
        return "tiktok"
    if "bilibili" in url or "b23.tv" in url:
        return "bilibili"
    raise ValueError(f"Cannot detect platform from URL: {url}")


def _is_tiktok_url(url: str) -> bool:
    return bool(re.search(r"tiktok\.com|douyin\.com|vt\.tiktok|vm\.tiktok|b23\.tv|bilibili", url))


def _first_url(value: Any) -> str:
    if not value:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list) and value:
        item = value[0]
        if isinstance(item, str):
            return item
        if isinstance(item, dict):
            return _first_url(item)
    if isinstance(value, dict):
        if value.get("url"):
            return value["url"]
        url_list = value.get("url_list") or value.get("urlList") or []
        if url_list and isinstance(url_list, list):
            first = url_list[0]
            return first if isinstance(first, str) else _first_url(first)
    return ""


def _num(value: Any) -> int:
    if isinstance(value, (int, float)) and value == value:
        return int(value)
    return 0


def _sanitize_filename_part(value: Optional[str], fallback: str) -> str:
    if not value:
        return fallback
    cleaned = re.sub(r"[^a-zA-Z0-9]", "_", value)
    cleaned = re.sub(r"_+", "_", cleaned)
    cleaned = cleaned.strip("_")
    return cleaned or fallback


def _build_content_disposition(filename: str, download: bool) -> str:
    from urllib.parse import quote

    disposition = "attachment" if download else "inline"
    ascii_name = re.sub(r"[^\x20-\x7E]", "", filename)
    safe = ascii_name.replace('"', "'")
    if ascii_name == filename:
        return f'{disposition}; filename="{safe}"'
    return f"{disposition}; filename=\"{safe}\"; filename*=UTF-8''{quote(filename)}"


def _extract_no_watermark(url_list: list) -> str:
    if not url_list:
        return ""
    for url in url_list:
        if not url:
            continue
        if "watermark=0" in url:
            return url
    for url in url_list:
        if not url:
            continue
        if ("zjcdn.com" in url or "douyinvod.com" in url or "tiktokcdn" in url) and "watermark" not in url:
            return url
    return url_list[0] if url_list else ""


def _extract_cover_url(video: Dict[str, Any], raw_data: Dict[str, Any]) -> str:
    for key in ("cover", "origin_cover", "dynamic_cover"):
        cover = video.get(key)
        url = _first_url(cover)
        if url:
            return url
    pic = raw_data.get("pic", "")
    if isinstance(pic, str) and pic:
        return pic
    if isinstance(pic, dict):
        return pic.get("url", "") or ""
    return ""


def _extract_author_avatar(author: Dict[str, Any]) -> str:
    for field in ("avatar_larger", "avatar_medium", "avatar_thumb", "avatar_thumb_168x108"):
        val = author.get(field)
        url = _first_url(val)
        if url:
            return url
    avatar_list = author.get("avatar_url_list") or []
    if avatar_list:
        return _first_url(avatar_list)
    avatar = author.get("avatar", "")
    if isinstance(avatar, str):
        return avatar
    return _first_url(avatar)


def _build_statistics(raw_data: Dict[str, Any]) -> Dict[str, int]:
    s = raw_data.get("statistics") or raw_data.get("stat") or {}
    return {
        "play_count": _num(s.get("play_count") or s.get("playCount") or s.get("views")),
        "digg_count": _num(s.get("digg_count") or s.get("likeCount") or s.get("likes")),
        "comment_count": _num(s.get("comment_count") or s.get("commentCount")),
        "share_count": _num(s.get("share_count") or s.get("shareCount")),
    }


def _build_author(raw_data: Dict[str, Any], platform: str) -> Dict[str, str]:
    author = raw_data.get("author") or raw_data.get("owner") or {}
    nickname = author.get("nickname") or author.get("name") or "unknown"
    if platform == "bilibili":
        unique_id = str(author.get("mid") or author.get("name") or "unknown")
    else:
        unique_id = author.get("unique_id") or author.get("uniqueId") or author.get("short_id") or author.get("mid") or "unknown"
    signature = author.get("signature") or author.get("sign") or ""
    avatar = _extract_author_avatar(author)
    return {
        "nickname": nickname,
        "uniqueId": unique_id,
        "signature": signature,
        "avatar": avatar,
        "avatarThumb": avatar,
        "avatarMedium": avatar,
        "avatarLarger": avatar,
    }


def _is_photo_post(raw_data: Dict[str, Any], platform: str) -> bool:
    if platform == "tiktok":
        images = raw_data.get("images") or []
        if images:
            return True
        info = raw_data.get("image_post_info")
        if info and isinstance(info, dict):
            imgs = info.get("images") or []
            return bool(imgs)
        return False
    if platform == "douyin":
        return bool(raw_data.get("images"))
    return False


def _get_image_urls(raw_data: Dict[str, Any], platform: str) -> List[str]:
    urls: List[str] = []
    if platform == "tiktok":
        images = raw_data.get("images") or []
        for img in images:
            url = _first_url(img)
            if url:
                urls.append(url)
        if not urls and raw_data.get("image_post_info"):
            for img in (raw_data["image_post_info"].get("images") or []):
                if isinstance(img, dict):
                    display = img.get("display_image") or img
                    url = _first_url(display)
                    if url:
                        urls.append(url)
    elif platform == "douyin":
        for img in (raw_data.get("images") or []):
            url_list = img.get("url_list") or img.get("download_url_list") or []
            if url_list:
                urls.append(_first_url(url_list))
            else:
                url = _first_url(img)
                if url:
                    urls.append(url)
    return urls


def _get_music_url(raw_data: Dict[str, Any]) -> Optional[str]:
    music = raw_data.get("music")
    if not isinstance(music, dict):
        return None
    play = music.get("play_url") or music.get("playUrl")
    if isinstance(play, str) and play:
        return play
    if isinstance(play, dict):
        url_list = play.get("url_list") or []
        if url_list:
            return _first_url(url_list)
    return music.get("url") or None


def _get_video_candidates(raw_data: Dict[str, Any], platform: str) -> List[Dict[str, str]]:
    video = raw_data.get("video") or {}
    candidates: List[Dict[str, str]] = []

    if platform == "bilibili":
        play_data = raw_data.get("_playurl_data") or {}
        dash = play_data.get("dash", {})
        video_list = dash.get("video", [])
        v_url = video_list[0].get("baseUrl") if video_list else ""
        if v_url:
            candidates.append({"url": v_url, "quality": "no_watermark"})
        return candidates

    play_addr = video.get("play_addr") or {}
    play_urls = play_addr.get("url_list") or []
    nwm_hd = _extract_no_watermark(list(play_urls))

    if not nwm_hd:
        bit_rate = video.get("bit_rate") or []
        if bit_rate and isinstance(bit_rate, list) and bit_rate:
            hq = bit_rate[0]
            if isinstance(hq, dict):
                hq_addr = hq.get("play_addr") or {}
                hq_urls = hq_addr.get("url_list") or []
                nwm_hd = _extract_no_watermark(hq_urls)
                if not nwm_hd and hq_urls:
                    nwm_hd = hq_urls[0]

    download_addr = video.get("download_addr") or {}
    dl_urls = download_addr.get("url_list") or []
    wm_url = dl_urls[0] if dl_urls else ""

    if nwm_hd:
        candidates.append({"url": nwm_hd, "quality": "no_watermark_hd"})
    if wm_url:
        candidates.append({"url": wm_url, "quality": "watermark"})
    if not candidates and nwm_hd:
        candidates.append({"url": nwm_hd, "quality": "no_watermark"})
    return candidates


def _get_referer(platform: str) -> str:
    return {
        "douyin": "https://www.douyin.com/",
        "tiktok": "https://www.tiktok.com/",
        "bilibili": "https://www.bilibili.com/",
    }.get(platform, "https://www.tiktok.com/")


def _get_duration(raw_data: Dict[str, Any]) -> int:
    video = raw_data.get("video") or {}
    duration = video.get("duration", 0)
    if not duration:
        duration = raw_data.get("duration", 0)
    return _num(duration)


# ---------- Response builder ----------


async def _build_tiktok_response(
    raw_data: Dict[str, Any],
    platform: str,
    video_id: str,
    options: Dict[str, Any],
) -> Dict[str, Any]:
    author_info = _build_author(raw_data, platform)
    statistics = _build_statistics(raw_data)
    duration = _get_duration(raw_data)
    video = raw_data.get("video") or {}
    cover = _extract_cover_url(video, raw_data)
    desc = (raw_data.get("desc") or raw_data.get("title") or "").strip()
    music_url = _get_music_url(raw_data)
    safe_author = _sanitize_filename_part(author_info["nickname"], "tiktok")
    referer = _get_referer(platform)
    download_headers = {
        "Referer": referer,
        "Accept-Encoding": "identity",
        "User-Agent": CDN_HEADERS["User-Agent"],
    }

    if _is_photo_post(raw_data, platform):
        return await _build_photo_response(
            raw_data, platform, video_id, author_info, statistics,
            duration, cover, desc, music_url, safe_author, download_headers, options,
        )

    candidates = _get_video_candidates(raw_data, platform)
    links: Dict[str, Any] = {}
    seen_qualities = set()
    for c in candidates:
        quality = c["quality"]
        if quality in seen_qualities or not c["url"]:
            continue
        seen_qualities.add(quality)
        key = await session_store.create_session({
            "url": options.get("url", ""), "type": "video", "quality": quality,
            "direct_url": c["url"], "http_headers": download_headers,
            "author": safe_author, "platform": platform,
            "proxy": options.get("proxy"), "impersonate": options.get("impersonate"),
            "aweme_id": video_id, "duration": duration,
        })
        links[quality] = f"/tiktok/download?key={key}"

    if music_url:
        mp3_key = await session_store.create_session({
            "url": options.get("url", ""), "type": "mp3", "direct_url": music_url,
            "http_headers": download_headers, "author": safe_author, "platform": platform,
            "proxy": options.get("proxy"), "impersonate": options.get("impersonate"),
            "aweme_id": video_id, "duration": duration,
        })
        links["mp3"] = f"/tiktok/download?key={mp3_key}"

    return {
        "status": "tunnel", "extract_source": EXTRACT_SOURCE,
        "title": desc, "description": desc, "statistics": statistics,
        "artist": author_info["nickname"], "cover": cover, "duration": duration,
        "audio": music_url, "download_link": links, "music_duration": duration,
        "author": author_info,
    }


async def _build_photo_response(
    raw_data: Dict[str, Any], platform: str, video_id: str,
    author_info: Dict[str, str], statistics: Dict[str, int], duration: int,
    cover: str, desc: str, music_url: Optional[str], safe_author: str,
    download_headers: Dict[str, str], options: Dict[str, Any],
) -> Dict[str, Any]:
    image_urls = _get_image_urls(raw_data, platform)
    photo_keys: List[str] = []
    photos: List[Dict[str, Any]] = []

    for i, img_url in enumerate(image_urls):
        key = await session_store.create_session({
            "url": options.get("url", ""), "type": "photo", "photo_index": i + 1,
            "direct_url": img_url, "http_headers": download_headers,
            "author": safe_author, "platform": platform,
            "proxy": options.get("proxy"), "impersonate": options.get("impersonate"),
            "aweme_id": video_id, "duration": duration,
        })
        link = f"/tiktok/download?key={key}"
        photo_keys.append(link)
        photos.append({"type": "photo", "url": img_url, "download_link": link})

    links: Dict[str, Any] = {"no_watermark": photo_keys}

    if music_url:
        mp3_key = await session_store.create_session({
            "url": options.get("url", ""), "type": "mp3", "direct_url": music_url,
            "http_headers": download_headers, "author": safe_author, "platform": platform,
            "proxy": options.get("proxy"), "impersonate": options.get("impersonate"),
            "aweme_id": video_id, "duration": duration,
        })
        links["mp3"] = f"/tiktok/download?key={mp3_key}"

    slideshow_duration = duration or (len(image_urls) * 4)
    slideshow_key = await session_store.create_session({
        "url": options.get("url", ""), "type": "slideshow", "photo_urls": image_urls,
        "audio_url": music_url, "http_headers": download_headers,
        "author": safe_author, "platform": platform,
        "proxy": options.get("proxy"), "impersonate": options.get("impersonate"),
        "aweme_id": video_id, "duration": slideshow_duration, "referer": _get_referer(platform),
    })

    return {
        "status": "picker", "extract_source": EXTRACT_SOURCE,
        "title": desc, "description": desc, "statistics": statistics,
        "artist": author_info["nickname"], "cover": cover, "duration": duration,
        "audio": music_url, "download_link": links, "photos": photos,
        "download_slideshow": f"/tiktok/download?key={slideshow_key}",
        "author": author_info,
    }


# ---------- Extraction ----------


async def _fetch_raw(url: str, platform: str, options: Dict[str, Any]) -> Dict[str, Any]:
    crawler = await get_crawler()
    raw_data = await crawler.hybrid_parsing_single_video(url, minimal=False)

    if platform == "douyin":
        raw_data = raw_data.get("aweme_detail", raw_data)
    elif platform == "bilibili":
        raw_data = raw_data.get("data", raw_data)
        cid = raw_data.get("cid")
        if cid and not raw_data.get("_playurl_data"):
            try:
                playurl = await crawler.BilibiliWebCrawler.fetch_video_playurl(
                    raw_data.get("bvid") or raw_data.get("aid"), str(cid)
                )
                raw_data["_playurl_data"] = playurl.get("data", {})
            except Exception:
                raw_data["_playurl_data"] = {}

    if not raw_data or not isinstance(raw_data, dict):
        raise ValueError("No result returned from crawler")
    return raw_data


async def extract_post(url: str, options: Dict[str, Any]) -> Dict[str, Any]:
    # 1. Check response cache first (fast path, TTL 60s)
    cached = await response_cache.get_cached_response(url, options)
    if cached is not None:
        logger.debug("response cache hit for %s", url[:60])
        return cached

    platform = _detect_platform(url)
    video_id = ""

    async def _extract():
        raw = await _fetch_raw(url, platform, options)
        nonlocal video_id
        video_id = raw.get("aweme_id") or raw.get("bvid") or raw.get("aid") or ""
        return raw

    # 2. Extraction cache (raw crawler output, TTL 1800s) + concurrency limit + timeout
    async with _extraction_semaphore:
        raw_data = await asyncio.wait_for(
            extraction_cache.get_or_extract(url, options, _extract),
            timeout=EXTRACTION_TIMEOUT_SECONDS,
        )

    if not video_id:
        video_id = raw_data.get("aweme_id") or raw_data.get("bvid") or ""

    # 3. Build response (creates fresh sessions)
    result = await _build_tiktok_response(raw_data, platform, video_id, options)

    # 4. Cache the full response (TTL 60s, well below session TTL 300s)
    await response_cache.set_cached_response(url, options, result)

    return result


# ---------- URL refresh on 403 ----------


async def _refresh_url(session: Dict[str, Any]) -> Optional[str]:
    aweme_id = session.get("aweme_id")
    if not aweme_id:
        return None
    platform = session.get("platform", "tiktok")
    try:
        crawler = await get_crawler()
        if platform == "douyin":
            raw = await crawler.DouyinWebCrawler.fetch_one_video(aweme_id)
            raw_data = raw.get("aweme_detail", {})
        elif platform == "tiktok":
            raw_data = await crawler.TikTokAPPCrawler.fetch_one_video(aweme_id)
        else:
            return None

        video = raw_data.get("video") or {}
        play_addr = video.get("play_addr") or {}
        url_list = play_addr.get("url_list") or []
        refreshed = _extract_no_watermark(list(url_list))
        if not refreshed:
            bit_rate = video.get("bit_rate") or []
            if bit_rate:
                hq = bit_rate[0]
                hq_addr = hq.get("play_addr") or {}
                hq_urls = hq_addr.get("url_list") or []
                refreshed = _extract_no_watermark(hq_urls)
                if not refreshed and hq_urls:
                    refreshed = hq_urls[0]
        if refreshed:
            session["direct_url"] = refreshed
            return refreshed
    except Exception as exc:
        logger.warning("refresh_url failed: %s", exc)
    return None


def _should_refresh_on_403(body: bytes) -> bool:
    if not body:
        return True
    try:
        text = body.decode("utf-8", errors="ignore").lower()
    except Exception:
        return True
    permanent = ["geo", "region", "geofence", "do not have permission", "captcha", "verify", "blocked", "access denied"]
    for err in permanent:
        if err in text:
            return False
    return True


# ---------- Stream handlers ----------


async def _stream_direct(
    session: Dict[str, Any], filename: str, content_type: str,
    download: bool, request: Request,
) -> Response:
    direct_url = session.get("direct_url") or ""
    if not direct_url:
        return _error_json("No media URL available in session", 400, "bad_request")

    base_headers = dict(session.get("http_headers") or {})
    headers = {**CDN_HEADERS, **base_headers}
    range_header = request.headers.get("range")
    if range_header:
        headers["Range"] = range_header

    max_attempts = 2
    current_url = direct_url

    for attempt in range(max_attempts):
        client = httpx.AsyncClient(timeout=httpx.Timeout(300, connect=10), follow_redirects=True)
        try:
            req = client.build_request("GET", current_url, headers=headers)
            resp = await client.send(req, stream=True)

            if resp.status_code == 403 and attempt == 0:
                body = await resp.aread()
                await resp.aclose()
                await client.aclose()
                if _should_refresh_on_403(body):
                    new_url = await _refresh_url(session)
                    if new_url:
                        current_url = new_url
                        continue
                return _error_json("Upstream CDN returned 403", 403, "upstream_error")

            if resp.status_code >= 400:
                body = await resp.aread()
                await resp.aclose()
                await client.aclose()
                return _error_json(f"Upstream CDN returned {resp.status_code}", 502, "upstream_error")

            resp_headers = {
                "Content-Type": content_type,
                "Content-Disposition": _build_content_disposition(filename, download),
                "X-Accel-Buffering": "no",
                **CORS_HEADERS,
            }
            cl = resp.headers.get("content-length")
            if cl:
                resp_headers["Content-Length"] = cl
            cr = resp.headers.get("content-range")
            if cr:
                resp_headers["Content-Range"] = cr

            async def content_generator():
                try:
                    async for chunk in resp.aiter_bytes():
                        yield chunk
                finally:
                    await resp.aclose()
                    await client.aclose()

            return StreamingResponse(
                content_generator(), media_type=content_type,
                headers=resp_headers, status_code=resp.status_code,
            )
        except Exception as exc:
            await client.aclose()
            if attempt < max_attempts - 1:
                continue
            return _error_json(f"Stream error: {exc}", 502, "upstream_error")

    return _error_json("Stream failed after refresh", 502, "upstream_error")


async def _stream_slideshow(
    session: Dict[str, Any], author: str, download: bool,
) -> Response:
    photo_urls = session.get("photo_urls") or []
    audio_url = session.get("audio_url")
    referer = session.get("referer") or _get_referer(session.get("platform", "tiktok"))

    if not photo_urls:
        return _error_json("No photos available for slideshow", 400, "bad_request")

    async with _slideshow_semaphore:
        try:
            result = await render_slideshow(photo_urls, audio_url, referer=referer)
        except SlideshowError as exc:
            return _error_json(str(exc), exc.status, "slideshow_error")
        except Exception as exc:
            return _error_json(f"Slideshow failed: {exc}", 502, "slideshow_error")

    output_path = result["output_path"]
    temp_dir = result["temp_dir"]
    file_size = result["file_size"]

    fh = open_file_stream(output_path)

    async def stream_mp4():
        try:
            loop = asyncio.get_running_loop()
            while True:
                chunk = await loop.run_in_executor(None, fh.read, BUFFER_SIZE)
                if not chunk:
                    break
                yield chunk
        finally:
            fh.close()
            cleanup_temp(temp_dir)

    filename = f"{author}_slideshow.mp4"
    resp_headers = {
        "Content-Type": "video/mp4",
        "Content-Disposition": _build_content_disposition(filename, download),
        "Content-Length": str(file_size),
        "X-Accel-Buffering": "no",
        **CORS_HEADERS,
    }
    return StreamingResponse(stream_mp4(), media_type="video/mp4", headers=resp_headers)


# ---------- Route registration ----------


def register_tiktok_routes(app: FastAPI) -> None:

    @app.post("/tiktok")
    async def handle_tiktok(req: TikTokRequest, request: Request) -> Response:
        if not _check_api_key(request):
            return _error_json("Invalid or missing API Key", 401, "unauthorized")

        url = (req.url or "").strip()
        if not url:
            return _error_json("URL is required", 400, "bad_request")
        if not _is_tiktok_url(url):
            return _error_json("Only TikTok/Douyin/Bilibili URLs are supported", 400, "bad_request")

        options = {
            "url": url, "version": req.version or "v1",
            "proxy": req.proxy.strip() if req.proxy else None,
            "impersonate": req.impersonate.strip() if req.impersonate else None,
        }

        try:
            result = await extract_post(url, options)
            return _json_response(result)
        except asyncio.TimeoutError:
            return _error_json("Extraction timed out", 504, "timeout")
        except ValueError as exc:
            msg = str(exc)
            if re.search(r"Unsupported URL|not found|Unable to|Could not extract|Cannot", msg, re.I):
                return _error_json(msg, 400, "not_found")
            return _error_json(msg, 400, "bad_request")
        except Exception as exc:
            msg = str(exc)
            if re.search(r"blocked|private|restricted|403|captcha|verify", msg, re.I):
                return _error_json(msg, 403, "ip_blocked")
            logger.exception("unhandled error in /tiktok")
            return _error_json(msg, 500, "internal_error")

    @app.get("/tiktok/download")
    async def handle_tiktok_download(request: Request) -> Response:
        key = (request.query_params.get("key") or "").strip()
        if not key:
            return _error_json("Missing key query parameter", 400, "bad_request")

        raw_dl = (request.query_params.get("download") or "true").strip().lower()
        download = raw_dl not in ("0", "false", "no", "off")

        session = await session_store.get_session(key)
        if not session:
            return _error_json("Download link expired or invalid", 404, "not_found")

        author = _sanitize_filename_part(session.get("author"), "tiktok")
        session_type = session.get("type", "video")

        try:
            if session_type == "slideshow":
                return await _stream_slideshow(session, author, download)
            if session_type == "video":
                quality = session.get("quality") or "video"
                return await _stream_direct(session, f"{author}_{quality}.mp4", "video/mp4", download, request)
            if session_type == "photo":
                idx = session.get("photo_index") or 1
                return await _stream_direct(session, f"{author}_photo_{idx}.jpg", "image/jpeg", download, request)
            if session_type == "mp3":
                return await _stream_direct(session, f"{author}.mp3", "audio/mpeg", download, request)
            return _error_json(f"Unknown content type: {session_type}", 400, "bad_request")
        except SlideshowError as exc:
            return _error_json(str(exc), exc.status, "slideshow_error")
        except Exception as exc:
            logger.exception("unhandled error in /tiktok/download")
            return _error_json(f"Failed to stream media: {exc}", 502, "upstream_error")
