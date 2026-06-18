"""Gunicorn/Uvicorn entry point for the TikTok gateway API.

Exposes `app` at module level so gunicorn can import it directly:
    gunicorn server.run_server:app -c gunicorn.gateway.conf.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.app import build_app

app = build_app()

if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("SERVER_HOST", "0.0.0.0")
    port = int(os.environ.get("SERVER_PORT", "7789"))
    uvicorn.run(app, host=host, port=port, log_level=os.environ.get("LOG_LEVEL", "info"))
