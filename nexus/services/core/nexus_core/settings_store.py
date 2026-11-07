"""User-editable runtime preferences persisted in SQLite."""

from __future__ import annotations

from typing import Any

from .db.database import Database, dumps, loads
from .util import now_iso

MODEL_CATEGORIES = ["general", "reasoning", "coding", "documents", "classification", "embeddings"]

DEFAULTS: dict[str, Any] = {
    # Model routing: category -> Ollama model name ("" = use default_model).
    "models.default": "",
    "models.assignments": {c: "" for c in MODEL_CATEGORIES},
    # Keep only one large model resident at a time (24GB unified memory).
    "models.single_model_mode": True,
    "models.keep_alive": "10m",
    # Refuse to load a model whose weights exceed this fraction of currently-available RAM.
    "models.max_memory_fraction": 0.75,
    "models.num_ctx": 8192,
    # Agent runtime
    "agents.runtime": "auto",  # auto | hermes | native
    "agents.max_steps": 8,
    "agents.max_parallel": 1,
    # Cloud: disabled until the user explicitly enables it.
    "cloud.enabled": False,
    "cloud.provider": "",  # anthropic | openai_compatible
    "cloud.model": "",
    "cloud.base_url": "",
    "cloud.allow_documents": False,
    # Voice
    "voice.tts_enabled": False,
    "voice.voice": "",
    "voice.stt_engine": "auto",  # auto | mlx | whispercpp
    "voice.whisper_model": "",  # path to ggml model for whisper.cpp or HF repo for MLX
    # Memory
    "memory.auto_propose": True,  # propose (never auto-activate) memories after conversations
    "memory.inject_in_chat": True,
    # Knowledge
    "knowledge.max_file_mb": 25,
    "knowledge.embeddings_enabled": False,
    # Notifications
    "notifications.native": True,
    # Profile
    "profile.name": "",
}


class SettingsStore:
    def __init__(self, db: Database):
        self.db = db

    def get(self, key: str, default: Any = None) -> Any:
        row = self.db.query_one("SELECT value FROM settings WHERE key = ?", (key,))
        if row is None:
            return DEFAULTS.get(key, default) if default is None else default
        return loads(row["value"], DEFAULTS.get(key, default))

    def set(self, key: str, value: Any) -> None:
        self.db.execute(
            "INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (key, dumps(value), now_iso()),
        )

    def all(self) -> dict[str, Any]:
        result = dict(DEFAULTS)
        for row in self.db.query("SELECT key, value FROM settings"):
            result[row["key"]] = loads(row["value"])
        return result

    def update(self, values: dict[str, Any]) -> dict[str, Any]:
        for k, v in values.items():
            if k not in DEFAULTS:
                raise KeyError(k)
            self.set(k, v)
        return self.all()
