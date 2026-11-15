"""Small native macOS helpers written in Swift (OCR via Vision, calendar via EventKit).

They are compiled once with `swiftc` (part of Xcode's command-line tools) into <data>/bin and
then reused. If compilation isn't possible the caller falls back or reports a clear error.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
from importlib import resources
from pathlib import Path

from ..config import IS_MACOS

log = logging.getLogger(__name__)

_failed: set[str] = set()
bin_dir: Path | None = None  # set by AppState


def configure(directory: Path) -> None:
    global bin_dir
    bin_dir = directory


def helper(name: str) -> str | None:
    """Path to a ready helper binary (`nexus-ocr`, `nexus-cal`), compiling it on first use. None if unavailable."""
    env = os.environ.get("NEXUS_" + name.upper().replace("-", "_").replace("NEXUS_", "") + "_BIN")
    if env and os.access(env, os.X_OK):
        return env
    # Bundled next to the frozen core (standalone app).
    bundled = Path(sys.executable).parent / name
    if bundled.is_file() and os.access(bundled, os.X_OK):
        return str(bundled)
    if bin_dir is None:
        return None
    target = bin_dir / name
    if target.is_file() and os.access(target, os.X_OK):
        return str(target)
    if not IS_MACOS or name in _failed:
        return None
    swiftc = shutil.which("swiftc") or ("/usr/bin/swiftc" if os.path.exists("/usr/bin/swiftc") else None)
    if not swiftc:
        _failed.add(name)
        return None
    try:
        src = resources.files("nexus_core.native").joinpath(f"{name}.swift")
        with resources.as_file(src) as src_path:
            bin_dir.mkdir(parents=True, exist_ok=True)
            out = subprocess.run([swiftc, "-O", "-o", str(target), str(src_path)], capture_output=True, text=True, timeout=300)
        if out.returncode != 0:
            log.error("could not build %s: %s", name, out.stderr[-800:])
            _failed.add(name)
            return None
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.error("could not build %s: %s", name, exc)
        _failed.add(name)
        return None
    log.info("built native helper %s", target)
    return str(target)
