"""FastAPI application factory for the TikTok gateway API.

Wires up /tiktok, /tiktok/download, and /api/v1/* routes using the
Douyin_TikTok_Download_API crawlers as the backend engine.
"""

from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from typing import Any, Dict, List

import yaml
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from server.jobs import JobManager
from server.tiktok_api import register_tiktok_routes


class DownloadRequest(BaseModel):
    url: str


class JobResponse(BaseModel):
    job_id: str
    status: str
    url: str


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
        crawler = HybridCrawler()
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
        yield
        await manager.shutdown()

    app = FastAPI(
        title="TikTok Gateway API",
        version="1.0",
        description="REST API gateway for Douyin/TikTok download using Douyin_TikTok_Download_API engine.",
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
    )

    register_tiktok_routes(app)

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
