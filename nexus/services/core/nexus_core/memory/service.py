"""Persistent memory with provenance and human review.

Three distinct layers:
  * session context  – the messages of the current conversation (not stored here)
  * long-term memory – this table: small, reviewed facts with a source
  * indexed documents – the knowledge base (knowledge/service.py)

Memories extracted automatically are always created as `proposed`; they are
used in prompts only after the user approves them (status `active`).
Content that looks sensitive (credentials, card numbers, IDs) is flagged and
can never be auto-proposed.
"""

from __future__ import annotations

import json
import logging
import re
from typing import TYPE_CHECKING, Any

from ..db.database import Database
from ..events import EventBus
from ..knowledge.service import fts_query
from ..util import new_id, now_iso

if TYPE_CHECKING:
    from ..models.ollama import OllamaClient

log = logging.getLogger(__name__)

CATEGORIES = ["preference", "project", "task", "decision", "summary", "knowledge"]

_SENSITIVE_PATTERNS = [
    re.compile(r"\b(?:password|passwd|passcode|pin code|secret key|api[_ -]?key|access[_ -]?token|private key)\b", re.I),
    re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b"),  # common API key shapes
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\b(?:\d[ -]?){13,19}\b"),  # card-number-like digit runs
    re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),  # US SSN
    re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b"),  # IBAN-like
]


def looks_sensitive(text: str) -> bool:
    return any(p.search(text) for p in _SENSITIVE_PATTERNS)


class MemoryService:
    def __init__(self, db: Database, bus: EventBus):
        self.db = db
        self.bus = bus

    def get(self, memory_id: str) -> dict[str, Any] | None:
        return self.db.query_one("SELECT * FROM memories WHERE id = ?", (memory_id,))

    def list(self, category: str | None = None, status: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        clauses, params = [], []
        if category:
            clauses.append("category = ?")
            params.append(category)
        if status:
            clauses.append("status = ?")
            params.append(status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        return self.db.query(f"SELECT * FROM memories {where} ORDER BY pinned DESC, updated_at DESC LIMIT ?", (*params, limit))

    def create(self, category: str, content: str, *, source_type: str = "user", source_ref: str | None = None,
               status: str | None = None, pinned: bool = False, relevance: float = 0.5) -> dict[str, Any]:
        if category not in CATEGORIES:
            raise ValueError(f"category must be one of {CATEGORIES}")
        content = content.strip()
        if not content:
            raise ValueError("content is empty")
        sensitive = looks_sensitive(content)
        if status is None:
            status = "active" if source_type == "user" and not sensitive else "proposed"
        if sensitive and source_type != "user":
            raise ValueError("Refusing to store content that looks sensitive as an automatic memory.")
        dup = self.db.query_one("SELECT id FROM memories WHERE lower(content) = lower(?) AND status != 'archived'", (content,))
        if dup:
            return self.get(dup["id"])  # type: ignore[return-value]
        mid = new_id("mem")
        ts = now_iso()
        self.db.execute(
            "INSERT INTO memories(id, category, content, status, source_type, source_ref, sensitive, pinned, relevance, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (mid, category, content, status, source_type, source_ref, int(sensitive), int(pinned), relevance, ts, ts),
        )
        mem = self.get(mid)
        self.bus.publish("memory.changed", {"id": mid, "action": "created", "status": status})
        return mem  # type: ignore[return-value]

    def update(self, memory_id: str, **fields: Any) -> dict[str, Any]:
        allowed = {"category", "content", "status", "pinned", "relevance"}
        sets = {k: (int(v) if isinstance(v, bool) else v) for k, v in fields.items() if k in allowed and v is not None}
        if "category" in sets and sets["category"] not in CATEGORIES:
            raise ValueError("invalid category")
        if "content" in sets:
            sets["sensitive"] = int(looks_sensitive(sets["content"]))
        if sets:
            sets["updated_at"] = now_iso()
            cols = ", ".join(f"{k} = ?" for k in sets)
            self.db.execute(f"UPDATE memories SET {cols} WHERE id = ?", (*sets.values(), memory_id))
        mem = self.get(memory_id)
        if not mem:
            raise KeyError(memory_id)
        self.bus.publish("memory.changed", {"id": memory_id, "action": "updated"})
        return mem

    def delete(self, memory_id: str) -> None:
        self.db.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
        self.bus.publish("memory.changed", {"id": memory_id, "action": "deleted"})

    def recall(self, query: str, limit: int = 6, mark_used: bool = True) -> list[dict[str, Any]]:
        """Relevant ACTIVE memories for a prompt: FTS match ranked with pin/relevance boosts, plus pinned preferences."""
        results: dict[str, dict[str, Any]] = {}
        q = fts_query(query, "or")
        if q:
            rows = self.db.query(
                "SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid "
                "WHERE memories_fts MATCH ? AND m.status = 'active' ORDER BY rank LIMIT ?",
                (q, limit * 2),
            )
            for r in rows:
                r["score"] = -r.pop("rank") + r["relevance"] + (1.0 if r["pinned"] else 0)
                results[r["id"]] = r
        for r in self.db.query("SELECT * FROM memories WHERE status='active' AND pinned=1 ORDER BY updated_at DESC LIMIT 5"):
            results.setdefault(r["id"], {**r, "score": 1.0 + r["relevance"]})
        ordered = sorted(results.values(), key=lambda r: -r["score"])[:limit]
        if mark_used and ordered:
            ts = now_iso()
            self.db.executemany(
                "UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?", [(ts, r["id"]) for r in ordered]
            )
        return ordered

    async def propose_from_conversation(self, ollama: "OllamaClient", model: str, conversation_id: str,
                                        transcript: str) -> list[dict[str, Any]]:
        """Ask the local model for durable facts worth remembering. Results are PROPOSED only."""
        prompt = (
            "Extract at most 5 durable facts worth remembering long-term about the user from this conversation: "
            "stable preferences, ongoing projects, important decisions, or open tasks. Ignore small talk and one-off details. "
            "NEVER include passwords, keys, financial or identity numbers. Respond with JSON only: "
            '{"memories": [{"category": "preference|project|task|decision", "content": "..."}]}. '
            'If nothing qualifies respond {"memories": []}.\n\nConversation:\n' + transcript[-12000:]
        )
        res = await ollama.chat(model, [{"role": "user", "content": prompt}], options={"temperature": 0.1})
        items = _parse_json_list(res.content, "memories")
        created = []
        for item in items[:5]:
            cat, content = str(item.get("category", "")).strip(), str(item.get("content", "")).strip()
            if cat not in CATEGORIES or not content or looks_sensitive(content):
                continue
            try:
                created.append(self.create(cat, content, source_type="conversation", source_ref=conversation_id, status="proposed"))
            except ValueError:
                continue
        return created

    def context_block(self, memories: list[dict[str, Any]]) -> str:
        if not memories:
            return ""
        lines = [f"- [{m['category']}] {m['content']}" for m in memories]
        return "What you know about the user (from reviewed long-term memory):\n" + "\n".join(lines)


def _parse_json_list(text: str, key: str) -> list[dict[str, Any]]:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except ValueError:
        return []
    items = data.get(key, []) if isinstance(data, dict) else []
    return [i for i in items if isinstance(i, dict)]
