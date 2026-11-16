from __future__ import annotations

import functools
import subprocess
from pathlib import Path

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


@functools.lru_cache(maxsize=4)
def build_id(root: str) -> str:
    """The git commit this core was started from ("" if unknown). The app compares it with its own build to
    notice a background service left over from an older version."""
    import os
    import sys

    if getattr(sys, "frozen", False):
        return os.environ.get("NEXUS_BUILD", "")  # the self-contained app tells its bundled core which build it is
    try:
        out = subprocess.run(["git", "-C", str(Path(root)), "rev-parse", "--short=7", "HEAD"], capture_output=True, text=True, timeout=5)
        return out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""
