from __future__ import annotations

import secrets
import time
from datetime import datetime, timezone


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def new_id(prefix: str) -> str:
    # Time-sortable, URL-safe id: prefix_<ms-hex><random>
    return f"{prefix}_{int(time.time() * 1000):x}{secrets.token_hex(5)}"


def truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"
