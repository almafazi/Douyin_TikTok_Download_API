"""Entry point for the TikTok gateway API server."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn
from server.app import build_app

host = os.environ.get("SERVER_HOST", "0.0.0.0")
port = int(os.environ.get("SERVER_PORT", "8089"))

app = build_app()

if __name__ == "__main__":
    uvicorn.run(app, host=host, port=port, log_level="info")
