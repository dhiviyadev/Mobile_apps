"""Help the user get Ollama running: find it, start it, and say exactly what is missing."""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..config import IS_MACOS
from .ollama import OllamaError

if TYPE_CHECKING:
    from ..app_state import AppState

APP_PATHS = (Path("/Applications/Ollama.app"), Path.home() / "Applications" / "Ollama.app")
BIN_PATHS = ("/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", str(Path.home() / ".local" / "bin" / "ollama"))
DOWNLOAD_URL = "https://ollama.com/download"


def find_app() -> Path | None:
    return next((p for p in APP_PATHS if p.exists()), None)


def find_binary() -> str | None:
    return shutil.which("ollama") or next((p for p in BIN_PATHS if os.access(p, os.X_OK)), None)


async def status(st: "AppState") -> dict[str, Any]:
    """online / installed / which models — and the single next step to take."""
    version = await st.ollama.version()
    models: list[str] = []
    if version:
        try:
            models = [m["name"] for m in await st.ollama.list_models() if "embed" not in m["name"]]
        except OllamaError:
            models = []
    app, binary = find_app(), find_binary()
    installed = bool(version or app or binary)
    if not installed:
        step = "install"
    elif not version:
        step = "start"
    elif not models:
        step = "model"
    else:
        step = "ready"
    return {"online": bool(version), "version": version, "installed": installed, "app": str(app) if app else None,
            "binary": binary, "models": models, "next_step": step, "can_start": IS_MACOS and bool(app or binary),
            "download_url": DOWNLOAD_URL}


async def start(st: "AppState") -> dict[str, Any]:
    """Open the Ollama app (or run `ollama serve`) and wait until it answers. macOS only; nothing is installed."""
    if await st.ollama.version():
        return await status(st)
    if not IS_MACOS:
        raise OllamaError("Starting Ollama from NEXUS works on a Mac. Start it yourself with `ollama serve`.")
    app, binary = find_app(), find_binary()
    if app:
        proc = await asyncio.create_subprocess_exec("/usr/bin/open", "-g", "-a", str(app))
        await proc.wait()
    elif binary:
        logs = st.settings.logs_dir / "ollama.log"
        with open(logs, "ab") as out:
            subprocess.Popen([binary, "serve"], stdout=out, stderr=out, stdin=subprocess.DEVNULL, start_new_session=True)  # noqa: S603
    else:
        raise OllamaError(f"Ollama isn't installed. Download it from {DOWNLOAD_URL}, open it once, then come back.")
    st.audit.record("user", "ollama.start", str(app or binary), "executed")
    for _ in range(40):
        await asyncio.sleep(0.5)
        if await st.ollama.version():
            st.bus.publish("settings.updated", {"keys": ["ollama"]})
            return await status(st)
    raise OllamaError("Ollama was started but isn't answering yet. Give it a few seconds and press the button again.")
