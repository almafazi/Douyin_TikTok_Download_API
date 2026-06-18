"""Response cache for POST /tiktok.

Caches the FULL JSON response (including download_link keys) for a short TTL
(60s) so repeated requests to the same URL return identical responses
instantly without re-calling the crawler or creating new sessions.

TTL is intentionally short (60s) and well below the session TTL (300s) so
that cached download_link keys remain valid for the cache lifetime.

Key: SHA-256(url|proxy|impersonate|version), prefix tiktok:resp:
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from typing import Any, Dict, Optional

REDIS_URL = os.environ.get("REDIS_URL", "")
RESPONSE_CACHE_TTL = int(os.environ.get("TIKTOK_RESPONSE_CACHE_TTL_SECONDS", "60"))

KEY_PREFIX = "tiktok:resp:"

logger = logging.getLogger("gateway.response_cache")


def _build_key(url: str, options: Dict[str, Any]) -> str:
    raw = f"{url}|{options.get('proxy') or ''}|{options.get('impersonate') or ''}|{options.get('version') or ''}"
    return f"{KEY_PREFIX}{hashlib.sha256(raw.encode()).hexdigest()}"


class _MemoryStore:
    def __init__(self) -> None:
        self._store: Dict[str, str] = {}
        self._expires: Dict[str, float] = {}
        self._timers: Dict[str, asyncio.TimerHandle] = {}

    def _evict(self, key: str) -> None:
        self._store.pop(key, None)
        self._expires.pop(key, None)
        h = self._timers.pop(key, None)
        if h:
            h.cancel()

    async def get(self, key: str) -> Optional[str]:
        if key not in self._store:
            return None
        if time.time() >= self._expires.get(key, 0):
            self._evict(key)
            return None
        return self._store[key]

    async def set(self, key: str, value: str, ttl: int) -> None:
        self._evict(key)
        self._store[key] = value
        self._expires[key] = time.time() + ttl
        loop = asyncio.get_running_loop()
        self._timers[key] = loop.call_later(ttl, self._evict, key)

    async def close(self) -> None:
        for h in self._timers.values():
            h.cancel()
        self._timers.clear()
        self._store.clear()
        self._expires.clear()


class _RedisStore:
    def __init__(self, url: str) -> None:
        import redis.asyncio as aioredis

        self._client = aioredis.from_url(
            url, max_connections=8, decode_responses=True,
            socket_connect_timeout=5, socket_timeout=5,
        )

    async def get(self, key: str) -> Optional[str]:
        return await self._client.get(key)

    async def set(self, key: str, value: str, ttl: int) -> None:
        await self._client.set(key, value, ex=ttl)

    async def close(self) -> None:
        try:
            await self._client.aclose()
        except Exception:
            pass


_store: Any = None
_use_redis = False
_lock = asyncio.Lock()


async def _get_store():
    global _store, _use_redis
    if _store is not None:
        return _store
    async with _lock:
        if _store is not None:
            return _store
        if REDIS_URL:
            try:
                rs = _RedisStore(REDIS_URL)
                await rs.get("__ping__")
                _store = rs
                _use_redis = True
                logger.info("Using Redis backend (TTL=%ds)", RESPONSE_CACHE_TTL)
            except Exception as exc:
                logger.warning("Redis init failed (%s), using memory", exc)
                _store = _MemoryStore()
                _use_redis = False
        else:
            _store = _MemoryStore()
            _use_redis = False
            logger.info("Using in-memory backend (TTL=%ds)", RESPONSE_CACHE_TTL)
        return _store


def is_response_cache_redis() -> bool:
    return _use_redis


def response_cache_ttl() -> int:
    return RESPONSE_CACHE_TTL


async def get_cached_response(url: str, options: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    try:
        store = await _get_store()
        key = _build_key(url, options)
        raw = await store.get(key)
        if raw:
            logger.debug("response cache hit: %s", key[:24])
            return json.loads(raw)
    except Exception as exc:
        logger.warning("response cache get error: %s", exc)
    return None


async def set_cached_response(url: str, options: Dict[str, Any], response: Dict[str, Any]) -> None:
    try:
        store = await _get_store()
        key = _build_key(url, options)
        await store.set(key, json.dumps(response), RESPONSE_CACHE_TTL)
    except Exception as exc:
        logger.warning("response cache set error: %s", exc)


async def close_response_cache() -> None:
    global _store, _use_redis
    if _store is not None:
        try:
            await _store.close()
        except Exception:
            pass
    _store = None
    _use_redis = False
