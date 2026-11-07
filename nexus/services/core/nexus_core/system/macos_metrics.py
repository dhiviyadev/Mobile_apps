"""Native macOS telemetry that does not require root.

GPU utilisation is intentionally NOT reported: on macOS the only reliable
source (`powermetrics`) requires sudo, and NEXUS will not fabricate numbers.
"""

from __future__ import annotations

import platform
import subprocess
from functools import lru_cache
from typing import Any

IS_MACOS = platform.system() == "Darwin"

_PRESSURE_LEVELS = {1: "normal", 2: "warning", 4: "critical"}


def _sysctl(name: str) -> str | None:
    if not IS_MACOS:
        return None
    try:
        out = subprocess.run(["/usr/sbin/sysctl", "-n", name], capture_output=True, text=True, timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def memory_pressure() -> dict[str, Any]:
    """kern.memorystatus_vm_pressure_level: 1=normal, 2=warning, 4=critical (macOS only)."""
    raw = _sysctl("kern.memorystatus_vm_pressure_level")
    if raw is None:
        return {"available": False, "level": None, "label": "unavailable", "source": None}
    try:
        lvl = int(raw)
    except ValueError:
        return {"available": False, "level": None, "label": "unavailable", "source": None}
    return {"available": True, "level": lvl, "label": _PRESSURE_LEVELS.get(lvl, "unknown"),
            "source": "sysctl kern.memorystatus_vm_pressure_level"}


@lru_cache(maxsize=1)
def hardware() -> dict[str, Any]:
    info: dict[str, Any] = {"platform": platform.system(), "machine": platform.machine(), "os_release": platform.release()}
    if IS_MACOS:
        info["chip"] = _sysctl("machdep.cpu.brand_string")
        info["model"] = _sysctl("hw.model")
        mem = _sysctl("hw.memsize")
        info["memory_bytes"] = int(mem) if mem and mem.isdigit() else None
        info["perf_cores"] = _sysctl("hw.perflevel0.physicalcpu")
        info["efficiency_cores"] = _sysctl("hw.perflevel1.physicalcpu")
        try:
            out = subprocess.run(["/usr/bin/sw_vers", "-productVersion"], capture_output=True, text=True, timeout=2)
            info["macos_version"] = out.stdout.strip() or None
        except (OSError, subprocess.TimeoutExpired):
            info["macos_version"] = None
    return info


GPU_NOTE = (
    "GPU utilisation is not reported: macOS only exposes it via `powermetrics`, which requires root. "
    "Ollama's per-model VRAM residency (size_vram) is shown instead."
)
