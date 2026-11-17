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


def _git_head(root: str) -> str:
    try:
        out = subprocess.run(["git", "-C", str(Path(root)), "rev-parse", "--short=7", "HEAD"], capture_output=True, text=True, timeout=5)
        return out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


@functools.lru_cache(maxsize=4)
def build_id(root: str) -> str:
    """The git commit this core was started from ("" if unknown). Read once, at start."""
    import os
    import sys

    if getattr(sys, "frozen", False):
        return os.environ.get("NEXUS_BUILD", "")  # the self-contained app tells its bundled core which build it is
    return _git_head(root)


_head_now: dict[str, tuple[float, str]] = {}


def is_stale(root: str) -> bool:
    """Has the code on disk moved on since this core started (an update was pulled while it kept running)?

    That is exactly the situation where the app's new screens talk to old server code and things quietly fail,
    so the core reports it and the app offers to restart it. Checked at most every 15 seconds.
    """
    import sys
    import time

    started = build_id(root)
    if not started or getattr(sys, "frozen", False):
        return False
    hit = _head_now.get(root)
    if not hit or time.time() - hit[0] > 15:
        hit = (time.time(), _git_head(root))
        _head_now[root] = hit
    return bool(hit[1]) and hit[1] != started
