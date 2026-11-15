"""Download and remove Ollama models from inside NEXUS, with live progress."""

from __future__ import annotations

import re
import time
from typing import TYPE_CHECKING, Any

from .catalog import catalog

if TYPE_CHECKING:
    from ..app_state import AppState

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}(:[A-Za-z0-9._-]{1,80})?$")


class ModelManager:
    def __init__(self, state: "AppState"):
        self.state = state
        self.pulls: dict[str, dict[str, Any]] = {}  # model -> latest progress

    async def catalog(self) -> list[dict[str, Any]]:
        try:
            installed = {m["name"] for m in await self.state.ollama.list_models()}
        except Exception:  # noqa: BLE001 - Ollama offline: still show suggestions
            installed = set()
        return catalog(installed)

    def start_pull(self, model: str) -> dict[str, Any]:
        model = model.strip()
        if not _NAME.match(model):
            raise ValueError("That doesn't look like an Ollama model name (e.g. qwen3:14b).")
        if model in self.pulls and self.pulls[model].get("status") not in ("done", "failed", "cancelled"):
            raise ValueError(f"{model} is already downloading.")
        st = self.state
        task = st.tasks.create(f"Download {model}", "model", input=model)
        self.pulls[model] = {"model": model, "task_id": task["id"], "status": "starting", "completed": 0, "total": 0, "percent": 0}
        st.bus.publish("model.pull", self.pulls[model])

        async def work() -> str:
            layers: dict[str, tuple[int, int]] = {}
            last = 0.0
            try:
                async for chunk in st.ollama.pull_stream(model):
                    if chunk.get("digest") and chunk.get("total"):
                        layers[chunk["digest"]] = (int(chunk.get("completed") or 0), int(chunk["total"]))
                    done = sum(c for c, _ in layers.values())
                    total = sum(t for _, t in layers.values())
                    self.pulls[model].update(status=chunk.get("status") or "downloading", completed=done, total=total,
                                             percent=round(done / total * 100, 1) if total else 0)
                    if time.monotonic() - last > 0.4:
                        last = time.monotonic()
                        st.bus.publish("model.pull", self.pulls[model])
            except BaseException as exc:
                self.pulls[model].update(status="cancelled" if exc.__class__.__name__ == "CancelledError" else "failed",
                                         error=str(exc)[:300])
                st.bus.publish("model.pull", self.pulls[model])
                raise
            self.pulls[model].update(status="done", percent=100)
            st.bus.publish("model.pull", self.pulls[model])
            st.audit.record("user", "model.pull", model, "executed")
            await st.notifications.notify("Model ready", f"{model} finished downloading.", native=False)
            return f"Downloaded {model}"

        st.tasks.start(task["id"], work, exclusive=False)
        return self.pulls[model]

    async def delete(self, model: str) -> None:
        st = self.state
        await st.ollama.delete(model)
        # Clear routing entries that pointed at it.
        if st.prefs.get("models.default") == model:
            st.prefs.set("models.default", "")
        assignments = st.prefs.get("models.assignments") or {}
        st.prefs.set("models.assignments", {k: ("" if v == model else v) for k, v in assignments.items()})
        st.audit.record("user", "model.delete", model, "executed")
        st.bus.publish("model.pull", {"model": model, "status": "deleted"})

    def active(self) -> list[dict[str, Any]]:
        return [p for p in self.pulls.values() if p.get("status") not in ("done", "failed", "cancelled")]
