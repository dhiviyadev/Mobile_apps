"""Conversations: persistent sessions, streaming generation, regenerate, export."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from ..db.database import dumps, loads
from ..knowledge.service import HL_END, HL_START
from ..util import new_id, now_iso, truncate

if TYPE_CHECKING:
    from ..app_state import AppState

log = logging.getLogger(__name__)

BASE_SYSTEM = (
    "You are NEXUS, a calm, precise personal AI assistant running locally on the user's Mac. "
    "Answer clearly and concisely using Markdown. When you use the provided document excerpts, cite them as "
    "[n] matching the numbered sources. If you are not sure, say so. Never claim to have done something you did not do."
)


class ConversationService:
    def __init__(self, state: "AppState"):
        self.state = state
        self._generations: dict[str, asyncio.Event] = {}  # generation_id -> stop flag

    # -- CRUD ---------------------------------------------------------------
    def create(self, title: str | None = None, agent_id: str | None = None, model: str | None = None) -> dict[str, Any]:
        cid = new_id("cnv")
        ts = now_iso()
        self.state.db.execute(
            "INSERT INTO conversations(id, title, model, agent_id, created_at, updated_at) VALUES (?,?,?,?,?,?)",
            (cid, title or "New conversation", model, agent_id, ts, ts),
        )
        conv = self.get(cid)
        self.state.bus.publish("conversation.updated", conv or {})
        return conv  # type: ignore[return-value]

    def get(self, cid: str) -> dict[str, Any] | None:
        return self.state.db.query_one("SELECT * FROM conversations WHERE id = ?", (cid,))

    def list(self, limit: int = 50, query: str | None = None, include_archived: bool = False) -> list[dict[str, Any]]:
        where = [] if include_archived else ["archived = 0"]
        params: list[Any] = []
        if query:
            where.append("(title LIKE ? OR id IN (SELECT conversation_id FROM messages WHERE content LIKE ?))")
            params += [f"%{query}%", f"%{query}%"]
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        return self.state.db.query(
            f"SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count "
            f"FROM conversations c {clause} ORDER BY updated_at DESC LIMIT ?", (*params, limit))

    def update(self, cid: str, **fields: Any) -> dict[str, Any]:
        allowed = {"title", "model", "agent_id", "archived"}
        sets = {k: (int(v) if isinstance(v, bool) else v) for k, v in fields.items() if k in allowed and v is not None}
        if sets:
            cols = ", ".join(f"{k} = ?" for k in sets)
            self.state.db.execute(f"UPDATE conversations SET {cols}, updated_at = ? WHERE id = ?", (*sets.values(), now_iso(), cid))
        conv = self.get(cid)
        if not conv:
            raise KeyError(cid)
        self.state.bus.publish("conversation.updated", conv)
        return conv

    def delete(self, cid: str) -> None:
        self.state.db.execute("DELETE FROM conversations WHERE id = ?", (cid,))
        self.state.bus.publish("conversation.deleted", {"id": cid})

    def messages(self, cid: str) -> list[dict[str, Any]]:
        rows = self.state.db.query("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid", (cid,))
        for r in rows:
            r["metadata"] = loads(r["metadata"], {})
        return rows

    def add_message(self, cid: str, role: str, content: str, *, model: str | None = None, status: str = "complete",
                    task_id: str | None = None, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        mid = new_id("msg")
        self.state.db.execute(
            "INSERT INTO messages(id, conversation_id, role, content, model, status, task_id, metadata, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (mid, cid, role, content, model, status, task_id, dumps(metadata or {}), now_iso()),
        )
        self.state.db.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now_iso(), cid))
        conv = self.get(cid)
        if conv and conv["title"] == "New conversation" and role == "user":
            self.update(cid, title=truncate(content.strip().splitlines()[0] if content.strip() else "Conversation", 60))
        self.state.bus.publish("conversation.message", {"conversation_id": cid, "message_id": mid, "role": role})
        msg = self.state.db.query_one("SELECT * FROM messages WHERE id = ?", (mid,))
        assert msg is not None
        msg["metadata"] = loads(msg["metadata"], {})
        return msg

    def export_markdown(self, cid: str) -> str:
        conv = self.get(cid)
        if not conv:
            raise KeyError(cid)
        lines = [f"# {conv['title']}", "", f"_Exported from NEXUS · {now_iso()}_", ""]
        for m in self.messages(cid):
            who = {"user": "You", "assistant": "NEXUS"}.get(m["role"], m["role"])
            lines += [f"### {who}", "", m["content"], ""]
            srcs = m["metadata"].get("sources") or []
            if srcs:
                lines += ["Sources:"] + [f"{i + 1}. {s['title']} — {s.get('location') or ''} ({s['path']})" for i, s in enumerate(srcs)] + [""]
        return "\n".join(lines)

    # -- attachments --------------------------------------------------------
    def attachment_context(self, ids: list[str]) -> tuple[str, list[dict[str, Any]]]:
        if not ids:
            return "", []
        marks = ",".join("?" * len(ids))
        rows = self.state.db.query(f"SELECT id, filename, text FROM attachments WHERE id IN ({marks})", ids)
        parts, info = [], []
        for r in rows:
            parts.append(f"<attachment name=\"{r['filename']}\">\n{truncate(r['text'] or '(no extractable text)', 24000)}\n</attachment>")
            info.append({"id": r["id"], "filename": r["filename"]})
        return "\n\n".join(parts), info

    # -- generation ---------------------------------------------------------
    def stop(self, generation_id: str) -> bool:
        ev = self._generations.get(generation_id)
        if ev:
            ev.set()
            return True
        return False

    async def stream_reply(self, cid: str, content: str, *, model: str | None = None, attachments: list[str] | None = None,
                           use_knowledge: bool = True, use_memory: bool = True, allow_cloud: bool = False,
                           regenerate: bool = False) -> AsyncIterator[dict[str, Any]]:
        st = self.state
        st.approvals.ensure_not_halted()
        if not self.get(cid):
            raise KeyError(cid)
        gen_id = new_id("gen")
        stop = asyncio.Event()
        self._generations[gen_id] = stop
        try:
            if not regenerate:
                self.add_message(cid, "user", content, metadata={"attachments": attachments or []})
            yield {"type": "start", "generation_id": gen_id}

            history = [m for m in self.messages(cid) if m["role"] in ("user", "assistant") and m["status"] == "complete"][-16:]
            attach_text, attach_info = self.attachment_context(attachments or [])

            # Retrieval: reviewed memories + document excerpts, both shown to the user as sources.
            system = BASE_SYSTEM
            name = st.prefs.get("profile.name")
            if name:
                system += f" The user's name is {name}."
            memories = st.memory.recall(content, limit=5) if use_memory and st.prefs.get("memory.inject_in_chat") else []
            if memories:
                system += "\n\n" + st.memory.context_block(memories)
            sources: list[dict[str, Any]] = []
            if use_knowledge:
                stats = st.knowledge.stats()
                if stats.get("chunks"):
                    res = await st.knowledge.search(content, limit=5, ollama=st.ollama, router=st.router, record=False)
                    sources = res["results"][:5]
            if sources:
                excerpt = "\n\n".join(
                    f"[{i + 1}] {s['title']} ({s.get('location') or 'document'}):\n"
                    f"{s['snippet'].replace(HL_START, '').replace(HL_END, '')}"
                    for i, s in enumerate(sources)
                )
                system += "\n\nPossibly relevant excerpts from the user's documents:\n" + excerpt
                yield {"type": "sources", "sources": [{k: s.get(k) for k in ("title", "path", "location", "document_id", "match")} for s in sources]}
            if memories:
                yield {"type": "memories", "memories": [{"id": m["id"], "category": m["category"], "content": m["content"]} for m in memories]}

            msgs = [{"role": "system", "content": system}] + [{"role": m["role"], "content": m["content"]} for m in history]
            if attach_text and msgs[-1]["role"] == "user":
                msgs[-1] = {"role": "user", "content": f"{attach_text}\n\n{msgs[-1]['content']}"}

            text, metrics, used_model, provider = "", {}, model, "ollama"
            if allow_cloud and st.cloud.status()["enabled"]:
                provider = "cloud"
                includes_docs = bool(attach_text or sources)
                st.audit.record("user", "cloud.request", st.cloud.status()["provider"], "allowed", documents=includes_docs, conversation=cid)
                async for kind, value in st.cloud.chat_stream(msgs, allow_cloud=True, includes_documents=includes_docs):
                    if stop.is_set():
                        break
                    if kind == "delta":
                        text += value
                        yield {"type": "delta", "text": value}
                    elif kind == "done":
                        used_model = value.get("model")
            else:
                used_model = await st.router.resolve("general", model)
                yield {"type": "model", "model": used_model}
                check = await st.router.memory_check(used_model)
                if not check["already_loaded"]:
                    yield {"type": "status", "status": "loading_model", "model": used_model}
                    await st.router.ensure_loaded(used_model)
                stream = st.ollama.chat_stream(used_model, msgs, options=st.router.chat_options(),
                                               keep_alive=st.prefs.get("models.keep_alive"))
                async for kind, value in stream:
                    if stop.is_set():
                        break
                    if kind == "delta":
                        text += value
                        yield {"type": "delta", "text": value}
                    elif kind == "thinking":
                        yield {"type": "thinking", "text": value}
                    elif kind == "done":
                        metrics = value.metrics()
                        st.router.record_metric("chat", used_model, result=value)
                await stream.aclose()  # closes the HTTP stream if we stopped early
            stopped = stop.is_set()
            msg = self.add_message(
                cid, "assistant", text, model=used_model, status="stopped" if stopped else "complete",
                metadata={"metrics": metrics, "provider": provider,
                          "sources": [{k: s.get(k) for k in ("title", "path", "location", "document_id")} for s in sources],
                          "memories": [m["id"] for m in memories], "attachments": attach_info},
            )
            yield {"type": "done", "message": msg, "stopped": stopped, "metrics": metrics}
        finally:
            self._generations.pop(gen_id, None)

    def prepare_regenerate(self, cid: str) -> str:
        """Drop the last assistant reply; return the user message to answer again."""
        msgs = self.messages(cid)
        while msgs and msgs[-1]["role"] == "assistant":
            self.state.db.execute("DELETE FROM messages WHERE id = ?", (msgs[-1]["id"],))
            msgs.pop()
        if not msgs or msgs[-1]["role"] != "user":
            raise ValueError("Nothing to regenerate")
        return msgs[-1]["content"]
