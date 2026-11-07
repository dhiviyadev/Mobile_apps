"""Machine + service health snapshot, sampled cheaply.

A background sampler runs every 5 s only while at least one client is
connected to the event stream, so an idle NEXUS costs ~nothing.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections import deque
from typing import TYPE_CHECKING, Any

import psutil

from .macos_metrics import GPU_NOTE, hardware, memory_pressure

if TYPE_CHECKING:
    from ..app_state import AppState


class SystemMonitor:
    def __init__(self, state: "AppState"):
        self.state = state
        self.history: deque[dict[str, Any]] = deque(maxlen=120)  # 10 minutes @ 5s
        self._proc = psutil.Process(os.getpid())
        self._started = time.time()
        psutil.cpu_percent(None)  # prime the non-blocking counter

    def sample(self) -> dict[str, Any]:
        vm = psutil.virtual_memory()
        sw = psutil.swap_memory()
        s = {
            "ts": time.time(),
            "cpu_percent": psutil.cpu_percent(None),
            "memory_percent": vm.percent,
            "memory_used": vm.total - vm.available,
            "memory_available": vm.available,
            "swap_used": sw.used,
            "pressure": memory_pressure().get("label"),
        }
        self.history.append(s)
        return s

    async def services(self) -> dict[str, Any]:
        st = self.state
        ollama_version = await st.ollama.version()
        running: list[dict[str, Any]] = []
        if ollama_version:
            try:
                running = await st.ollama.running_models()
            except Exception:  # noqa: BLE001
                running = []
        hermes = await st.hermes.status(cached=True)
        try:
            st.db.query_one("SELECT 1 AS ok")
            db_ok = True
        except Exception:  # noqa: BLE001
            db_ok = False
        db_size = st.settings.db_path.stat().st_size if st.settings.db_path.exists() else 0
        return {
            "core": {"status": "ok", "uptime_s": round(time.time() - self._started), "pid": os.getpid(),
                     "rss_bytes": self._proc.memory_info().rss},
            "ollama": {"status": "ok" if ollama_version else "offline", "version": ollama_version,
                       "url": st.settings.ollama_url,
                       "loaded_models": [
                           {"name": m.get("name"), "size": m.get("size"), "size_vram": m.get("size_vram"),
                            "expires_at": m.get("expires_at"), "context_length": m.get("context_length")}
                           for m in running
                       ],
                       "transitions": dict(st.router.loading)},
            "hermes": hermes,
            "database": {"status": "ok" if db_ok else "error", "path": str(st.settings.db_path), "size_bytes": db_size},
            "voice": st.voice.status(),
        }

    async def snapshot(self) -> dict[str, Any]:
        vm = psutil.virtual_memory()
        sw = psutil.swap_memory()
        disk = psutil.disk_usage(str(self.state.settings.data_dir))
        try:
            load = os.getloadavg()
        except OSError:
            load = None
        return {
            "hardware": hardware(),
            "cpu": {"percent": psutil.cpu_percent(None), "per_core": psutil.cpu_percent(None, percpu=True),
                    "count": psutil.cpu_count(), "load_avg": load},
            "memory": {"total": vm.total, "available": vm.available, "used": vm.total - vm.available,
                       "percent": vm.percent, "swap_used": sw.used, "swap_total": sw.total,
                       "pressure": memory_pressure()},
            "gpu": {"available": False, "note": GPU_NOTE},
            "disk": {"total": disk.total, "used": disk.used, "free": disk.free, "percent": disk.percent,
                     "path": str(self.state.settings.data_dir)},
            "inference": self.state.router.inference_stats(),
            "services": await self.services(),
            "tasks": {"active": self.state.tasks.active_count,
                      "queued_or_running": len(self.state.tasks.list(status="active", limit=200))},
            "halted": self.state.approvals.halted,
            "history": list(self.history),
        }

    async def run_sampler(self) -> None:
        while True:
            await asyncio.sleep(5)
            if self.state.bus.subscriber_count == 0:
                continue
            s = self.sample()
            self.state.bus.publish("system.sample", s)
