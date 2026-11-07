"""Model routing and memory-aware model lifecycle for a unified-memory Mac.

* Each task category maps to an installed model (user-assigned), falling back
  to the default model, then to the first installed chat model.
* Before a model is loaded we compare its on-disk size (a good lower bound on
  resident size) against currently available memory, and refuse with a clear
  message rather than pushing macOS into swap.
* In single-model mode, other resident chat models are unloaded first so only
  one large model occupies unified memory at a time. Embedding models are
  small and are allowed to stay resident.
"""

from __future__ import annotations

import logging
from typing import Any

import psutil

from ..db.database import Database, dumps
from ..settings_store import MODEL_CATEGORIES, SettingsStore
from ..util import now_iso
from .ollama import ChatResult, OllamaClient

log = logging.getLogger(__name__)


class ModelUnavailable(Exception):
    pass


def is_embedding_model(m: dict[str, Any]) -> bool:
    name = (m.get("name") or m.get("model") or "").lower()
    fam = " ".join((m.get("details") or {}).get("families") or []).lower()
    return "embed" in name or "bert" in fam or "nomic-bert" in fam


class ModelRouter:
    def __init__(self, ollama: OllamaClient, settings: SettingsStore, db: Database):
        self.ollama = ollama
        self.settings = settings
        self.db = db
        self.loading: dict[str, str] = {}  # model -> "loading" | "unloading"

    async def installed(self) -> list[dict[str, Any]]:
        return await self.ollama.list_models()

    async def resolve(self, category: str = "general", explicit: str | None = None) -> str:
        models = await self.installed()
        names = [m["name"] for m in models]
        if not names:
            raise ModelUnavailable("No Ollama models are installed. Pull one with `ollama pull <model>`.")
        if explicit:
            if explicit in names:
                return explicit
            raise ModelUnavailable(f"Model '{explicit}' is not installed in Ollama.")
        assignments: dict[str, str] = self.settings.get("models.assignments") or {}
        candidate = assignments.get(category) or ""
        if candidate in names:
            return candidate
        if category == "embeddings":
            emb = [m["name"] for m in models if is_embedding_model(m)]
            if emb:
                return emb[0]
            raise ModelUnavailable("No embedding model installed (e.g. `ollama pull nomic-embed-text`).")
        default = self.settings.get("models.default") or ""
        if default in names:
            return default
        chat_models = [m for m in models if not is_embedding_model(m)]
        if not chat_models:
            raise ModelUnavailable("Only embedding models are installed; install a chat model.")
        # Smallest chat model first: a safe default on a 24GB machine until the user chooses.
        chat_models.sort(key=lambda m: m.get("size", 0))
        return chat_models[0]["name"]

    def routing_table(self) -> dict[str, str]:
        assignments = self.settings.get("models.assignments") or {}
        return {c: assignments.get(c, "") for c in MODEL_CATEGORIES}

    async def memory_check(self, model: str) -> dict[str, Any]:
        models = {m["name"]: m for m in await self.installed()}
        running = {m["name"]: m for m in await self.ollama.running_models()}
        size = int(models.get(model, {}).get("size", 0))
        vm = psutil.virtual_memory()
        already = model in running
        # Memory that would be freed by unloading other chat models in single-model mode.
        reclaimable = 0
        if self.settings.get("models.single_model_mode"):
            reclaimable = sum(int(m.get("size", 0)) for n, m in running.items() if n != model and not is_embedding_model(m))
        budget = (vm.available + reclaimable) * float(self.settings.get("models.max_memory_fraction") or 0.75)
        return {
            "model": model,
            "model_bytes": size,
            "available_bytes": vm.available,
            "reclaimable_bytes": reclaimable,
            "budget_bytes": int(budget),
            "already_loaded": already,
            "fits": already or size == 0 or size <= budget,
        }

    async def ensure_loaded(self, model: str) -> dict[str, Any]:
        check = await self.memory_check(model)
        if check["already_loaded"]:
            return {"model": model, "loaded": True, "load_ms": 0, "check": check}
        if not check["fits"]:
            gb = 1024**3
            raise ModelUnavailable(
                f"Not enough free memory to load {model} safely: needs ~{check['model_bytes'] / gb:.1f} GB, "
                f"budget is {check['budget_bytes'] / gb:.1f} GB. Close apps, pick a smaller model, "
                f"or raise models.max_memory_fraction."
            )
        if self.settings.get("models.single_model_mode"):
            for m in await self.ollama.running_models():
                if m["name"] != model and not is_embedding_model(m):
                    log.info("single-model mode: unloading %s before loading %s", m["name"], model)
                    self.loading[m["name"]] = "unloading"
                    try:
                        await self.ollama.unload(m["name"])
                    finally:
                        self.loading.pop(m["name"], None)
        self.loading[model] = "loading"
        try:
            info = await self.ollama.load(model, keep_alive=self.settings.get("models.keep_alive") or "10m")
        finally:
            self.loading.pop(model, None)
        self.record_metric("load", model, load_ms=info.get("load_ms") or info.get("wall_ms"), detail=info)
        return {"model": model, "loaded": True, **info, "check": check}

    async def unload(self, model: str) -> None:
        self.loading[model] = "unloading"
        try:
            await self.ollama.unload(model)
        finally:
            self.loading.pop(model, None)

    def chat_options(self) -> dict[str, Any]:
        return {"num_ctx": int(self.settings.get("models.num_ctx") or 8192)}

    def record_metric(self, kind: str, model: str, *, load_ms: float | None = None, result: ChatResult | None = None,
                      detail: dict[str, Any] | None = None) -> None:
        r = result
        self.db.execute(
            "INSERT INTO metrics(ts, kind, model, load_ms, ttft_ms, total_ms, prompt_tokens, eval_tokens, tokens_per_s, detail) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (now_iso(), kind, model, r.load_ms if r else load_ms, r.ttft_ms if r else None, r.total_ms if r else None,
             r.prompt_tokens if r else None, r.eval_tokens if r else None, r.tokens_per_s if r else None, dumps(detail or {})),
        )

    def inference_stats(self, limit: int = 50) -> dict[str, Any]:
        rows = self.db.query(
            "SELECT * FROM metrics WHERE kind IN ('chat','agent','benchmark') ORDER BY id DESC LIMIT ?", (limit,)
        )
        tps = [r["tokens_per_s"] for r in rows if r["tokens_per_s"]]
        ttft = [r["ttft_ms"] for r in rows if r["ttft_ms"]]
        return {
            "samples": len(rows),
            "avg_tokens_per_s": round(sum(tps) / len(tps), 2) if tps else None,
            "avg_ttft_ms": round(sum(ttft) / len(ttft), 1) if ttft else None,
            "last": rows[0] if rows else None,
        }
