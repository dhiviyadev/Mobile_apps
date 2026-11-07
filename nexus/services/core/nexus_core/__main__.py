"""Entry point: `python -m nexus_core`."""

from __future__ import annotations

import logging
import logging.handlers
import sys

import uvicorn

from .api.app import create_app
from .config import Settings


def configure_logging(settings: Settings) -> None:
    settings.ensure_dirs()
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    root = logging.getLogger()
    root.setLevel(level)
    console = logging.StreamHandler(sys.stderr)
    console.setFormatter(fmt)
    fileh = logging.handlers.RotatingFileHandler(settings.logs_dir / "core.log", maxBytes=5 * 1024 * 1024, backupCount=3)
    fileh.setFormatter(fmt)
    root.handlers = [console, fileh]


def main() -> None:
    settings = Settings()
    if settings.host not in ("127.0.0.1", "localhost", "::1"):
        print("Refusing to bind NEXUS core to a non-loopback address.", file=sys.stderr)
        sys.exit(2)
    configure_logging(settings)
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level=settings.log_level,
                access_log=False, timeout_graceful_shutdown=8)


if __name__ == "__main__":
    main()
