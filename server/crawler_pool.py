"""Singleton HybridCrawler pool.

HybridCrawler creates 4 internal crawlers (Douyin/TikTok web + TikTok app +
Bilibili), each with its own httpx.AsyncClient connection pool. Creating a
new HybridCrawler per request leaks connection pools. This module provides a
process-wide singleton that is reused across requests and closed on shutdown.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

logger = logging.getLogger("gateway.crawler")

_crawler: Optional[object] = None
_lock = asyncio.Lock()


async def get_crawler():
    global _crawler
    if _crawler is not None:
        return _crawler
    async with _lock:
        if _crawler is not None:
            return _crawler
        from crawlers.hybrid.hybrid_crawler import HybridCrawler

        _crawler = HybridCrawler()
        logger.info("HybridCrawler singleton initialized")
        return _crawler


async def close_crawler() -> None:
    global _crawler
    if _crawler is None:
        return
    crawler = _crawler
    _crawler = None
    for attr in ("DouyinWebCrawler", "TikTokWebCrawler", "TikTokAPPCrawler", "BilibiliWebCrawler"):
        sub = getattr(crawler, attr, None)
        if sub is None:
            continue
        aclient = getattr(sub, "aclient", None)
        if aclient is not None:
            try:
                await aclient.aclose()
            except Exception as exc:
                logger.warning("Error closing %s.aclient: %s", attr, exc)
        base = getattr(sub, "BaseCrawler", None)
        if base is not None:
            bc_aclient = getattr(base, "aclient", None)
            if bc_aclient is not None:
                try:
                    await bc_aclient.aclose()
                except Exception as exc:
                    logger.warning("Error closing %s.BaseCrawler.aclient: %s", attr, exc)
    logger.info("HybridCrawler singleton closed")
