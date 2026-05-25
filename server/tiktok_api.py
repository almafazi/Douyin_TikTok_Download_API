"""TikTok-style REST API endpoints.

Mirrors gateway-go's /tiktok and /tiktok/download endpoints using the
Douyin_TikTok_Download_API crawlers (HybridCrawler). Streams media directly
to client without saving to disk.

POST /tiktok         - fetch video info, return download URLs
GET /tiktok/download - stream media with Range support and 403 refresh
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import tempfile
import uuid
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from crawlers.hybrid.hybrid_crawler import HybridCrawler

BUFFER_SIZE = 256 * 1024


class TikTokRequest(BaseModel):
    url: str
    proxy: Optional[str] = None
    impersonate: Optional[str] = None


class TikTokAuthor(BaseModel):
    nickname: str = ""
    uniqueId: str = ""
    signature: str = ""
    avatar: str = ""
    avatarThumb: str = ""
    avatarMedium: str = ""
    avatarLarger: str = ""


class TikTokResponse(BaseModel):
    status: str
    extract_source: str = "web"
    title: str = ""
    description: str = ""
    statistics: Dict[str, Any] = {}
    artist: str = ""
    cover: str = ""
    duration: int = 0
    audio: Optional[str] = None
    download_link: Dict[str, Any] = {}
    music_duration: int = 0
    author: TikTokAuthor = TikTokAuthor()
    photos: Optional[List[Dict[str, Any]]] = None
    download_slideshow: Optional[str] = None


class DeliveryPlan(BaseModel):
    direct_url: str = ""
    request_headers: Dict[str, str] = {}
    response_headers: Dict[str, str] = {}
    media_type: str = "video/mp4"
    can_refresh: bool = True
    needs_ffmpeg: bool = False
    platform: str = "douyin"
    ffmpeg_audio_url: Optional[str] = None
    ffmpeg_audio_headers: Dict[str, str] = {}
    ffmpeg_merge: bool = False
    ffmpeg_audio_only: bool = False
    session_type: str = "video"
    delivery_mode: str = "single_progressive"
    photo_urls: list = []
    audio_url: Optional[str] = None
    duration_per_image: int = 4
    content_type: str = "video"
    fallback_proxy: bool = False
    key: str = ""
    use_worker_mp3: bool = False
    bypass_proxy: bool = True


_session_store: Dict[str, Dict[str, Any]] = {}


def _generate_key() -> str:
    return f"w1::{uuid.uuid4().hex[:12]}"


def _store_session(key: str, data: Dict[str, Any]) -> None:
    _session_store[key] = data


def _get_session(key: str) -> Optional[Dict[str, Any]]:
    return _session_store.get(key)


def _detect_platform(url: str) -> str:
    if "douyin" in url:
        return "douyin"
    if "tiktok" in url:
        return "tiktok"
    if "bilibili" in url or "b23.tv" in url:
        return "bilibili"
    raise ValueError(f"Cannot detect platform from URL: {url}")


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


def _extract_cover_url(video: Dict[str, Any]) -> str:
    cover = video.get("cover")
    if not cover:
        return ""
    if isinstance(cover, dict):
        url_list = cover.get("url_list") or cover.get("urlList") or []
        if isinstance(url_list, list) and url_list:
            first = url_list[0]
            if isinstance(first, dict):
                return first.get("url", "")
            if isinstance(first, str):
                return first
    elif isinstance(cover, str):
        return cover
    return ""


def _extract_author_avatar(author: Dict[str, Any]) -> str:
    for field in ("avatar_larger", "avatar_medium", "avatar_thumb"):
        val = author.get(field)
        if isinstance(val, dict):
            url_list = val.get("url_list") or val.get("urlList") or []
            if url_list:
                first = url_list[0]
                if isinstance(first, str):
                    return first
                if isinstance(first, dict):
                    return first.get("url", "")
        elif isinstance(val, str) and val:
            return val
    urls = author.get("avatar_url_list") or author.get("avatar_168x168", {}).get("url_list") or []
    if urls:
        first = urls[0]
        return first if isinstance(first, str) else ""
    return author.get("avatar", "")


def _build_tiktok_response(raw_data: Dict[str, Any], platform: str, video_id: str) -> TikTokResponse:
    author = raw_data.get("author", {}) or {}
    video = raw_data.get("video", {}) or {}
    music = raw_data.get("music", {}) or {}
    statistics = raw_data.get("statistics", raw_data.get("stat", {})) or {}

    desc = (raw_data.get("desc", "") or raw_data.get("title", "") or "").strip()
    nickname = author.get("nickname", author.get("name", ""))

    session_key = _generate_key()

    play_addr = video.get("play_addr", {}) or {}
    url_list = play_addr.get("url_list") or []
    no_watermark_url = _extract_no_watermark(list(url_list))

    if not no_watermark_url:
        bit_rate = video.get("bit_rate", [])
        if bit_rate and isinstance(bit_rate, list) and len(bit_rate) > 0:
            hq = bit_rate[0]
            if isinstance(hq, dict):
                hq_addr = hq.get("play_addr", {}) or {}
                hq_urls = hq_addr.get("url_list") or []
                no_watermark_url = _extract_no_watermark(hq_urls)
                if not no_watermark_url and hq_urls:
                    no_watermark_url = hq_urls[0]

    if not no_watermark_url:
        download_addr = video.get("download_addr", {}) or {}
        dl_urls = download_addr.get("url_list") or []
        no_watermark_url = dl_urls[0] if dl_urls else ""

    music_play_url = music.get("play_url") if isinstance(music, dict) else None
    mp3_url = None
    if isinstance(music_play_url, dict):
        music_url_list = music_play_url.get("url_list") or []
        mp3_url = music_url_list[0] if isinstance(music_url_list, list) and music_url_list else None

    download_links: Dict[str, Any] = {}
    if no_watermark_url:
        download_links["no_watermark"] = f"/tiktok/download?key={session_key}"
    if mp3_url:
        download_links["mp3"] = f"/tiktok/download?key={session_key}_mp3"

    cover_url = _extract_cover_url(video)
    if not cover_url:
        cover_url = raw_data.get("pic", "") or ""
        if isinstance(cover_url, dict):
            cover_url = cover_url.get("url", "") or ""

    referer_map = {
        "douyin": "https://www.douyin.com/",
        "tiktok": "https://www.tiktok.com/",
        "bilibili": "https://www.bilibili.com/",
    }
    referer = referer_map.get(platform, "https://www.douyin.com/")

    download_headers = {
        "Referer": referer,
        "Accept-Encoding": "identity",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        ),
    }

    duration = video.get("duration", 0)
    if not duration:
        duration = raw_data.get("duration", 0)

    session_data = {
        "aweme_id": raw_data.get("aweme_id", "") or video_id,
        "desc": desc,
        "author_nickname": nickname,
        "cover": cover_url,
        "duration": duration,
        "no_watermark_url": no_watermark_url,
        "mp3_url": mp3_url,
        "download_headers": download_headers,
        "platform": platform,
    }
    _store_session(session_key, session_data)

    if mp3_url:
        mp3_session = dict(session_data)
        mp3_session["direct_url"] = mp3_url
        mp3_session["media_type"] = "audio/mpeg"
        mp3_session["session_type"] = "mp3"
        _store_session(f"{session_key}_mp3", mp3_session)

    avatar_url = _extract_author_avatar(author)

    download_links["watermark"] = download_links.get("no_watermark", "")

    is_gallery = bool(raw_data.get("images") or raw_data.get("image_post_info"))

    if is_gallery:
        return _build_gallery_response(
            raw_data, session_key, author, nickname, desc, statistics,
            cover_url, download_links, duration, avatar_url, platform, referer, mp3_url,
        )

    music_duration = 0
    if isinstance(music, dict):
        music_duration = music.get("duration", 0)

    unique_id = author.get("unique_id", author.get("short_id", author.get("mid", "")))
    signature = author.get("signature", author.get("sign", ""))

    return TikTokResponse(
        status="tunnel",
        extract_source="web",
        title=desc,
        description=desc,
        statistics=statistics if isinstance(statistics, dict) else {},
        artist=nickname,
        cover=cover_url,
        duration=duration,
        audio=mp3_url,
        download_link=download_links,
        music_duration=music_duration,
        author=TikTokAuthor(
            nickname=nickname,
            uniqueId=unique_id,
            signature=signature,
            avatar=avatar_url,
            avatarThumb=avatar_url,
            avatarMedium=avatar_url,
            avatarLarger=avatar_url,
        ),
    )


def _build_gallery_response(
    raw_data: Dict[str, Any],
    session_key: str,
    author: Dict[str, Any],
    nickname: str,
    desc: str,
    statistics: Dict[str, Any],
    cover_url: str,
    download_links: Dict[str, Any],
    duration: int,
    avatar_url: str,
    platform: str,
    referer: str,
    mp3_url: Optional[str],
) -> TikTokResponse:
    images = raw_data.get("images") or []
    if not images and raw_data.get("image_post_info"):
        images = raw_data["image_post_info"].get("images") or []

    photos = []
    image_keys: list = []

    download_headers = {
        "Referer": referer,
        "Accept-Encoding": "identity",
    }

    for i, img in enumerate(images):
        if not isinstance(img, dict):
            continue
        img_url_list = img.get("url_list") or img.get("download_url_list") or []
        if not img_url_list:
            continue
        img_url = img_url_list[0] if isinstance(img_url_list[0], str) else str(img_url_list[0])

        img_key = f"{session_key}_photo_{i}"
        img_data = {
            "aweme_id": raw_data.get("aweme_id", ""),
            "direct_url": img_url,
            "media_type": "image/jpeg",
            "session_type": "photo",
            "desc": desc,
            "cover": cover_url,
            "download_headers": download_headers,
            "duration": duration,
            "platform": platform,
        }
        _store_session(img_key, img_data)
        image_keys.append(img_key)

        photos.append({
            "type": "photo",
            "url": img_url,
            "download_link": f"/tiktok/download?key={img_key}",
        })

    download_links["no_watermark"] = [f"/tiktok/download?key={k}" for k in image_keys]

    slideshow_key = f"{session_key}_slideshow"
    slideshow_data = {
        "aweme_id": raw_data.get("aweme_id", ""),
        "photo_urls": [p["url"] for p in photos],
        "content_type": "slideshow",
        "session_type": "slideshow",
        "media_type": "video/mp4",
        "desc": desc,
        "cover": cover_url,
        "download_headers": download_headers,
        "duration_per_image": 4,
        "duration": duration,
        "audio_url": mp3_url,
        "platform": platform,
    }
    _store_session(slideshow_key, slideshow_data)

    return TikTokResponse(
        status="picker",
        extract_source="web",
        title=desc,
        description=desc,
        statistics=statistics if isinstance(statistics, dict) else {},
        artist=nickname,
        cover=cover_url,
        duration=duration,
        audio=mp3_url,
        download_link=download_links,
        music_duration=0,
        author=TikTokAuthor(
            nickname=nickname,
            uniqueId=author.get("unique_id", author.get("short_id", "")),
            signature=author.get("signature", ""),
            avatar=avatar_url,
            avatarThumb=avatar_url,
            avatarMedium=avatar_url,
            avatarLarger=avatar_url,
        ),
        photos=photos,
        download_slideshow=f"/tiktok/download?key={slideshow_key}",
    )


def _build_delivery_plan(session: Dict[str, Any], key: str) -> DeliveryPlan:
    direct_url = session.get("direct_url") or session.get("no_watermark_url") or ""
    media_type = session.get("media_type", "video/mp4")
    session_type = session.get("session_type", "video")
    content_type = session.get("content_type", session_type)

    if session_type == "mp3" or content_type == "mp3":
        media_type = "audio/mpeg"
        ext = "mp3"
    elif content_type == "slideshow":
        ext = "mp4"
    elif content_type == "photo":
        ext = "jpg"
    else:
        ext = "mp4"

    return DeliveryPlan(
        direct_url=direct_url,
        request_headers=session.get("download_headers", {
            "Accept-Encoding": "identity",
            "Referer": "https://www.douyin.com/",
        }),
        response_headers={
            "Content-Disposition": f'attachment; filename="{key}.{ext}"',
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache, no-store, must-revalidate",
        },
        media_type=media_type,
        can_refresh=(content_type != "slideshow"),
        platform=session.get("platform", "douyin"),
        session_type=session_type,
        delivery_mode="single_progressive",
        content_type=content_type,
        key=key,
        bypass_proxy=True,
        photo_urls=session.get("photo_urls") or [],
        audio_url=session.get("audio_url"),
        duration_per_image=session.get("duration_per_image", 4),
    )


async def _refresh_url(session: Dict[str, Any]) -> Optional[str]:
    aweme_id = session.get("aweme_id")
    if not aweme_id:
        return None

    platform = session.get("platform", "douyin")

    try:
        crawler = HybridCrawler()
        if platform == "douyin":
            raw = await crawler.DouyinWebCrawler.fetch_one_video(aweme_id)
            raw_data = raw.get("aweme_detail", {})
        elif platform == "tiktok":
            raw_data = await crawler.TikTokAPPCrawler.fetch_one_video(aweme_id)
        else:
            return None

        video = raw_data.get("video", {}) or {}
        play_addr = video.get("play_addr", {}) or {}
        url_list = play_addr.get("url_list") or []
        refreshed = _extract_no_watermark(list(url_list))

        if not refreshed:
            bit_rate = video.get("bit_rate", [])
            if bit_rate and isinstance(bit_rate, list) and len(bit_rate) > 0:
                hq = bit_rate[0]
                if isinstance(hq, dict):
                    hq_addr = hq.get("play_addr", {}) or {}
                    hq_urls = hq_addr.get("url_list") or []
                    refreshed = _extract_no_watermark(hq_urls)
                    if not refreshed and hq_urls:
                        refreshed = hq_urls[0]

        if refreshed:
            session["no_watermark_url"] = refreshed
            return refreshed
    except Exception:
        pass

    return None


def _should_refresh_on_403(body: bytes, platform: str) -> bool:
    if not body:
        return True
    try:
        body_str = body.decode("utf-8", errors="ignore").lower()
    except Exception:
        return True
    permanent = ["geo", "region", "geofence", "do not have permission", "captcha", "verify", "blocked", "access denied"]
    for err in permanent:
        if err in body_str:
            return False
    return True


async def _deliver_direct(
    plan: DeliveryPlan,
    request: Request,
    session: Dict[str, Any],
) -> StreamingResponse:
    current_url = plan.direct_url
    current_headers = dict(plan.request_headers)

    range_header = request.headers.get("Range")
    if range_header:
        current_headers["Range"] = range_header

    max_attempts = 2 if plan.can_refresh else 1

    for attempt in range(max_attempts):
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(300, connect=10),
            follow_redirects=True,
        )
        try:
            req = client.build_request("GET", current_url, headers=current_headers)
            resp = await client.send(req, stream=True)

            if resp.status_code == 403 and attempt == 0 and plan.can_refresh:
                body = await resp.aread()
                await resp.aclose()
                await client.aclose()
                if _should_refresh_on_403(body, plan.platform):
                    new_url = await _refresh_url(session)
                    if new_url:
                        current_url = new_url
                        continue
                return StreamingResponse(
                    iter([body]),
                    media_type=plan.media_type,
                    status_code=403,
                )

            if resp.status_code >= 400:
                body = await resp.aread()
                await resp.aclose()
                await client.aclose()
                return StreamingResponse(
                    iter([body]),
                    media_type=plan.media_type,
                    status_code=resp.status_code,
                )

            async def content_generator():
                try:
                    async for chunk in resp.aiter_bytes():
                        yield chunk
                finally:
                    await resp.aclose()
                    await client.aclose()

            return StreamingResponse(
                content_generator(),
                media_type=plan.media_type,
                headers={k: v for k, v in plan.response_headers.items()},
            )
        except Exception as e:
            await client.aclose()
            if attempt < max_attempts - 1:
                continue
            return StreamingResponse(
                iter([f"Stream error: {e}".encode()]),
                media_type="text/plain",
                status_code=502,
            )

    raise HTTPException(status_code=502, detail="Stream failed after refresh")


async def _stream_slideshow(
    session_data: Dict[str, Any],
    plan: DeliveryPlan,
) -> StreamingResponse:
    photo_urls = session_data.get("photo_urls") or []
    audio_url = session_data.get("audio_url") or plan.audio_url
    duration_per_image = plan.duration_per_image or 4

    temp_dir = tempfile.mkdtemp(prefix="douyin_slideshow_")
    output_path = os.path.join(temp_dir, "slideshow.mp4")

    try:
        timeout = httpx.Timeout(60, connect=10)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as http_client:
            image_paths = []
            headers = {"Referer": "https://www.douyin.com/", "Accept-Encoding": "identity"}
            for i, url in enumerate(photo_urls):
                img_path = os.path.join(temp_dir, f"image_{i}.jpg")
                try:
                    resp = await http_client.get(url, headers=headers)
                    if resp.status_code == 200:
                        with open(img_path, "wb") as f:
                            f.write(resp.content)
                        image_paths.append(img_path)
                except Exception as exc:
                    shutil.rmtree(temp_dir, ignore_errors=True)
                    return StreamingResponse(
                        iter([f'{{"error":"Failed to download slideshow image","detail":"{exc}"}}'.encode()]),
                        media_type="application/json",
                        status_code=502,
                    )

            audio_path = None
            if audio_url:
                audio_path = os.path.join(temp_dir, "audio.mp3")
                try:
                    resp = await http_client.get(audio_url, headers=headers)
                    if resp.status_code == 200:
                        with open(audio_path, "wb") as f:
                            f.write(resp.content)
                except Exception:
                    audio_path = None

            total_duration = len(image_paths) * duration_per_image
            ffmpeg = shutil.which("ffmpeg")
            if not ffmpeg:
                ffmpeg = os.environ.get("FFMPEG_PATH", "ffmpeg")

            ffmpeg_args = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error"]
            for img in image_paths:
                ffmpeg_args.extend(["-loop", "1", "-t", str(duration_per_image), "-i", img])
            if audio_path and os.path.exists(audio_path):
                ffmpeg_args.extend(["-stream_loop", "-1", "-i", audio_path])

            video_streams = []
            for i in range(len(image_paths)):
                video_streams.append(
                    f"[{i}:v]scale=w=720:h=1280:force_original_aspect_ratio=decrease,"
                    f"pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,"
                    f"fps=24,trim=duration={duration_per_image},setpts=PTS-STARTPTS[v{i}]"
                )
            concat_inputs = "".join(f"[v{i}]" for i in range(len(image_paths)))
            filter_parts = ";".join(video_streams)
            filter_parts += f";{concat_inputs}concat=n={len(image_paths)}:v=1:a=0[vout]"

            if audio_path and os.path.exists(audio_path):
                filter_parts += (
                    f";[{len(image_paths)}:a]atrim=0:{total_duration},asetpts=PTS-STARTPTS[aout]"
                )

            ffmpeg_args.extend(["-filter_complex", filter_parts, "-map", "[vout]"])
            if audio_path and os.path.exists(audio_path):
                ffmpeg_args.extend(["-map", "[aout]", "-c:a", "aac", "-b:a", "128k"])

            ffmpeg_args.extend([
                "-pix_fmt", "yuv420p", "-fps_mode", "cfr",
                "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage",
                "-crf", "28", "-b:v", "320k", "-maxrate", "360k", "-bufsize", "720k",
                "-threads", "1", "-max_muxing_queue_size", "1024",
                output_path,
            ])

            proc = await asyncio.create_subprocess_exec(
                *ffmpeg_args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            try:
                _, stderr_data = await asyncio.wait_for(proc.communicate(), timeout=90)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                shutil.rmtree(temp_dir, ignore_errors=True)
                return StreamingResponse(
                    iter([b'{"error":"ffmpeg timed out"}']),
                    media_type="application/json",
                    status_code=504,
                )

            if proc.returncode != 0:
                err = stderr_data.decode("utf-8", errors="replace")[-500:] if stderr_data else "unknown"
                shutil.rmtree(temp_dir, ignore_errors=True)
                return StreamingResponse(
                    iter([f'{{"error":"ffmpeg encode failed","detail":"{err}"}}'.encode()]),
                    media_type="application/json",
                    status_code=502,
                )

            file_size = os.path.getsize(output_path)
            fh = open(output_path, "rb")

            async def stream_mp4():
                try:
                    while True:
                        chunk = fh.read(BUFFER_SIZE)
                        if not chunk:
                            break
                        yield chunk
                finally:
                    fh.close()
                    shutil.rmtree(temp_dir, ignore_errors=True)

            return StreamingResponse(
                stream_mp4(),
                media_type="video/mp4",
                headers={
                    "Content-Disposition": 'attachment; filename="slideshow.mp4"',
                    "Content-Length": str(file_size),
                    "X-Accel-Buffering": "no",
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                },
            )

    except Exception as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        return StreamingResponse(
            iter([f'{{"error":"Slideshow failed","detail":"{exc}"}}'.encode()]),
            media_type="application/json",
            status_code=502,
        )


def register_tiktok_routes(app: FastAPI) -> None:

    @app.post("/tiktok")
    async def handle_tiktok(req: TikTokRequest) -> Response:
        if not req.url:
            return Response(
                content='{"error":"URL is required"}',
                media_type="application/json",
                status_code=400,
            )

        try:
            platform = _detect_platform(req.url)
            crawler = HybridCrawler()
            raw_data = await crawler.hybrid_parsing_single_video(req.url, minimal=False)

            if platform == "douyin":
                raw_data = raw_data.get("aweme_detail", raw_data)
            elif platform == "bilibili":
                raw_data = raw_data.get("data", raw_data)

            if not raw_data or not isinstance(raw_data, dict):
                return Response(
                    content='{"error":"Video not found"}',
                    media_type="application/json",
                    status_code=404,
                )

            video_id = raw_data.get("aweme_id", raw_data.get("bvid", ""))
            response = _build_tiktok_response(raw_data, platform, video_id)
            return Response(
                content=response.model_dump_json(),
                media_type="application/json",
            )
        except ValueError as e:
            return Response(
                content=f'{{"error":"{e}"}}',
                media_type="application/json",
                status_code=400,
            )
        except Exception as e:
            return Response(
                content=f'{{"error":"download_error","detail":"{e}"}}',
                media_type="application/json",
                status_code=500,
            )

    @app.get("/tiktok/download")
    async def handle_tiktok_download(request: Request) -> Response:
        key = request.query_params.get("key", "")
        raw = request.query_params.get("download", "true").strip().lower()
        download = raw not in ("0", "false", "no", "off")

        if not key:
            return Response(
                content='{"error":"Missing key query parameter"}',
                media_type="application/json",
                status_code=400,
            )

        session = _get_session(key)
        if not session:
            return Response(
                content='{"error":"Session not found or expired"}',
                media_type="application/json",
                status_code=404,
            )

        content_type = session.get("content_type") or "video"

        if content_type in ("photo",):
            plan = _build_delivery_plan(session, key)
            if not download:
                return Response(
                    content=plan.model_dump_json(),
                    media_type="application/json",
                )
            return await _deliver_direct(plan, request, session)

        if content_type == "slideshow":
            plan = _build_delivery_plan(session, key)
            if not download:
                return Response(
                    content=plan.model_dump_json(),
                    media_type="application/json",
                )
            return await _stream_slideshow(session, plan)

        plan = _build_delivery_plan(session, key)

        if not download:
            return Response(
                content=plan.model_dump_json(),
                media_type="application/json",
            )

        return await _deliver_direct(plan, request, session)
