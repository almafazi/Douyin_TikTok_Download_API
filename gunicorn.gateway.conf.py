"""Gunicorn config for the TikTok gateway API.

Multi-worker via UvicornWorker to utilize multiple CPU cores.
Workers = 2 * CPU + 1 (capped at 8).
"""

import multiprocessing
import os

bind = f"{os.environ.get('SERVER_HOST', '0.0.0.0')}:{os.environ.get('SERVER_PORT', '7789')}"
worker_class = "uvicorn.workers.UvicornWorker"
workers = int(os.environ.get("GUNICORN_WORKERS", str(min(8, multiprocessing.cpu_count() * 2 + 1))))
timeout = 120
loglevel = os.environ.get("LOG_LEVEL", "info")
accesslog = "-"
errorlog = "-"
max_requests = 1000
max_requests_jitter = 100
keepalive = 5
preload_app = True
graceful_timeout = 30
