"""Entry point: `python -m nexus_core`."""

from __future__ import annotations

import logging
import logging.handlers
import os
import re
import sys

import uvicorn

from .api.app import create_app
from .config import Settings


_SECRET_PATTERNS = [
    (re.compile(r"(token=)[^&\s\"']+", re.I), r"\1***"),
    (re.compile(r"(Bearer\s+)[A-Za-z0-9._~+/=-]+", re.I), r"\1***"),
]


class RedactSecrets(logging.Filter):
    """Never let an API or device token reach a log file (e.g. uvicorn logs WebSocket URLs with ?token=)."""

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        red = msg
        for pat, repl in _SECRET_PATTERNS:
            red = pat.sub(repl, red)
        if red != msg:
            record.msg, record.args = red, None
        return True


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
    redact = RedactSecrets()
    for h in (console, fileh):
        h.addFilter(redact)
    root.handlers = [console, fileh]
    # Route uvicorn's loggers through these handlers (and the redaction filter) instead of its own.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True
    try:
        os.chmod(settings.logs_dir, 0o700)
    except OSError:
        pass


def main() -> None:
    settings = Settings()
    if settings.host not in ("127.0.0.1", "localhost", "::1"):
        print("Refusing to bind NEXUS core to a non-loopback address.", file=sys.stderr)
        sys.exit(2)
    configure_logging(settings)
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level=settings.log_level,
                access_log=False, timeout_graceful_shutdown=8, log_config=None)


if __name__ == "__main__":
    main()
