"""FastAPI application factory for the TikTok gateway API.

Mirrors tiktok-api-dl endpoints: GET / , GET /health, POST /tiktok,
GET /tiktok/download. CORS preflight + optional X-API-Key auth.

Production hardening:
- Structured logging (not print)
- /docs /redoc disabled when ENV=production
- Request body size limit (1MB)
- Basic metrics endpoint (/metrics) with request counters
- Redis ping in /health
- Graceful shutdown of all backends
"""

from __future__ import annotations

import datetime
import logging
import os
import sys
from contextlib import asynccontextmanager
from typing import Any, Dict, List

import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response as StarletteResponse

from server import response_cache
from server import session as session_store
from server import extraction_cache
from server.crawler_pool import close_crawler
from server.jobs import JobManager
from server.tiktok_api import register_tiktok_routes

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("gateway.app")

TIKTOK_API_KEY = os.environ.get("TIKTOK_API_KEY", "")
DEFAULT_VERSION = os.environ.get("DEFAULT_VERSION", "v1")
FFMPEG_PATH = os.environ.get("FFMPEG_PATH", "ffmpeg")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "development")
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(1024 * 1024)))  # 1MB

IS_PROD = ENVIRONMENT == "production"

# ---------- Metrics ----------
_metrics = {
    "requests_total": 0,
    "tiktok_post_total": 0,
    "tiktok_download_total": 0,
    "tiktok_post_errors": 0,
    "tiktok_download_errors": 0,
    "slideshow_renders": 0,
}

_METRIC_KEYS = {
    "requests_total": "gateway:metrics:requests_total",
    "tiktok_post_total": "gateway:metrics:tiktok_post_total",
    "tiktok_download_total": "gateway:metrics:tiktok_download_total",
    "tiktok_post_errors": "gateway:metrics:tiktok_post_errors",
    "tiktok_download_errors": "gateway:metrics:tiktok_download_errors",
}


async def _incr_metric(name: str) -> None:
    _metrics[name] = _metrics.get(name, 0) + 1
    redis_url = os.environ.get("REDIS_URL", "")
    if not redis_url:
        return
    try:
        import redis.asyncio as aioredis
        if not hasattr(_incr_metric, "_redis"):
            _incr_metric._redis = aioredis.from_url(
                redis_url, max_connections=2, decode_responses=True,
                socket_connect_timeout=2, socket_timeout=2,
            )
        await _incr_metric._redis.incr(_METRIC_KEYS.get(name, f"gateway:metrics:{name}"))
    except Exception:
        pass


async def _read_metrics() -> dict:
    redis_url = os.environ.get("REDIS_URL", "")
    if not redis_url:
        return {**_metrics, "environment": ENVIRONMENT}
    try:
        import redis.asyncio as aioredis
        if not hasattr(_read_metrics, "_redis"):
            _read_metrics._redis = aioredis.from_url(
                redis_url, max_connections=2, decode_responses=True,
                socket_connect_timeout=2, socket_timeout=2,
            )
        result = {}
        for name, rkey in _METRIC_KEYS.items():
            val = await _read_metrics._redis.get(rkey)
            result[name] = int(val) if val else 0
        return {**result, "environment": ENVIRONMENT}
    except Exception:
        return {**_metrics, "environment": ENVIRONMENT}


class DownloadRequest(BaseModel):
    url: str


class JobResponse(BaseModel):
    job_id: str
    status: str
    url: str


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        cl = request.headers.get("content-length")
        if cl and int(cl) > MAX_BODY_BYTES:
            return StarletteResponse(
                content='{"error":"Request body too large"}',
                media_type="application/json",
                status_code=413,
            )
        return await call_next(request)


class MetricsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        await _incr_metric("requests_total")
        path = request.url.path
        if path == "/tiktok" and request.method == "POST":
            await _incr_metric("tiktok_post_total")
        elif path == "/tiktok/download" and request.method == "GET":
            await _incr_metric("tiktok_download_total")
        response = await call_next(request)
        if response.status_code >= 400:
            if path == "/tiktok":
                await _incr_metric("tiktok_post_errors")
            elif path == "/tiktok/download":
                await _incr_metric("tiktok_download_errors")
        return response


def _load_config() -> dict:
    config_path = os.environ.get("CONFIG_PATH", "config.yaml")
    if not os.path.isabs(config_path):
        config_path = os.path.join(
            os.path.dirname(os.path.dirname(__file__)), config_path
        )
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def build_app() -> FastAPI:
    config = _load_config()

    from crawlers.hybrid.hybrid_crawler import HybridCrawler

    async def _executor(url: str) -> Dict[str, int]:
        from server.crawler_pool import get_crawler
        crawler = await get_crawler()
        try:
            result = await crawler.hybrid_parsing_single_video(url, minimal=True)
            if result and result.get("type") in ("video", "image"):
                return {"total": 1, "success": 1, "failed": 0, "skipped": 0}
            return {"total": 1, "success": 0, "failed": 1, "skipped": 0}
        except Exception:
            return {"total": 1, "success": 0, "failed": 1, "skipped": 0}

    server_cfg = config.get("server") or {}
    if not isinstance(server_cfg, dict):
        server_cfg = {}

    manager = JobManager(
        executor=_executor,
        max_concurrency=int(config.get("thread", 2) or 2),
        max_jobs=int(server_cfg.get("max_jobs", JobManager.DEFAULT_MAX_JOBS)),
        job_ttl_seconds=float(
            server_cfg.get("job_ttl_seconds", JobManager.DEFAULT_JOB_TTL_SECONDS)
        ),
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logger.info("Starting TikTok Gateway API (env=%s)", ENVIRONMENT)
        yield
        logger.info("Shutting down...")
        await manager.shutdown()
        await close_crawler()
        await session_store.close_session_store()
        await extraction_cache.close_extraction_cache()
        await response_cache.close_response_cache()
        logger.info("Shutdown complete")

    app = FastAPI(
        title="TikTok Gateway API",
        version="1.0",
        description="REST API gateway for Douyin/TikTok/Bilibili download using Douyin_TikTok_Download_API engine.",
        lifespan=lifespan,
        docs_url=None if IS_PROD else "/docs",
        redoc_url=None if IS_PROD else "/redoc",
        openapi_url=None if IS_PROD else "/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Accept", "X-API-Key"],
    )
    app.add_middleware(BodySizeLimitMiddleware)
    app.add_middleware(MetricsMiddleware)

    register_tiktok_routes(app)

    @app.get("/")
    async def handle_root() -> Dict[str, Any]:
        return {
            "service": "tiktok-gateway-api",
            "status": "ok",
            "transport": "fastapi + Douyin_TikTok_Download_API",
            "endpoints": ["/", "/health", "/metrics", "/tiktok", "/tiktok/download"],
        }

    @app.get("/health")
    async def handle_health() -> Dict[str, Any]:
        sessions = await session_store.active_session_count()
        redis_ok = await session_store.redis_ping()
        return {
            "status": "ok" if redis_ok else "degraded",
            "time": datetime.datetime.utcnow().isoformat() + "Z",
            "version": DEFAULT_VERSION,
            "environment": ENVIRONMENT,
            "active_sessions": sessions,
            "session_backend": "redis" if session_store.is_redis_backend() else "memory",
            "extract_cache_backend": "redis" if extraction_cache.is_extract_cache_redis() else "memory",
            "extract_cache_ttl_seconds": extraction_cache.extract_cache_ttl(),
            "response_cache_backend": "redis" if response_cache.is_response_cache_redis() else "memory",
            "response_cache_ttl_seconds": response_cache.response_cache_ttl(),
            "redis_ok": redis_ok,
            "ffmpeg": FFMPEG_PATH,
        }

    @app.get("/metrics")
    async def handle_metrics() -> Dict[str, Any]:
        return await _read_metrics()

    @app.get("/api/v1/health")
    async def health() -> Dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/v1/download", response_model=JobResponse)
    async def create_job(req: DownloadRequest) -> JobResponse:
        if not req.url:
            raise HTTPException(status_code=400, detail="url is required")
        job = await manager.submit(req.url)
        return JobResponse(job_id=job.job_id, status=job.status, url=job.url)

    @app.get("/api/v1/jobs/{job_id}")
    async def get_job(job_id: str) -> Dict[str, Any]:
        job = await manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        return job.to_dict()

    @app.get("/api/v1/jobs")
    async def list_jobs() -> Dict[str, List[Dict[str, Any]]]:
        jobs = await manager.list_jobs()
        return {"jobs": [j.to_dict() for j in jobs]}

    return app
