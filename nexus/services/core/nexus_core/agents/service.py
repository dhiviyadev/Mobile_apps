"""Agent orchestration: picks a runtime (Hermes first, native fallback) and runs tasks sequentially."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from ..db.database import dumps, loads
from ..util import new_id, now_iso
from .hermes import HermesUnavailable
from .native_runtime import run_native
from .profiles import decode_agent

if TYPE_CHECKING:
    from ..app_state import AppState

log = logging.getLogger(__name__)


class AgentService:
    def __init__(self, state: "AppState"):
        self.state = state

    def list(self) -> list[dict[str, Any]]:
        agents = [decode_agent(r) for r in self.state.db.query("SELECT * FROM agents ORDER BY builtin DESC, name")]
        stats = {r["agent_id"]: r for r in self.state.db.query(
            "SELECT agent_id, COUNT(*) AS runs, SUM(status='completed') AS completed, SUM(status='failed') AS failed, "
            "MAX(created_at) AS last_run_at FROM tasks WHERE agent_id IS NOT NULL GROUP BY agent_id")}
        active = {t["agent_id"]: t for t in self.state.tasks.list(status="active", limit=100) if t.get("agent_id")}
        out = []
        for a in agents:
            assert a is not None
            s = stats.get(a["id"], {})
            a["stats"] = {"runs": s.get("runs", 0) or 0, "completed": s.get("completed", 0) or 0,
                          "failed": s.get("failed", 0) or 0, "last_run_at": s.get("last_run_at")}
            cur = active.get(a["id"])
            a["current_task"] = {"id": cur["id"], "title": cur["title"], "status": cur["status"]} if cur else None
            a["status"] = "busy" if cur else ("idle" if a["enabled"] else "disabled")
            out.append(a)
        return out

    def get(self, agent_id: str) -> dict[str, Any] | None:
        return decode_agent(self.state.db.query_one("SELECT * FROM agents WHERE id = ?", (agent_id,)))

    def update(self, agent_id: str, **fields: Any) -> dict[str, Any]:
        allowed = {"name", "role", "description", "system_prompt", "model_category", "tools", "hermes_toolsets", "runtime_pref", "enabled"}
        sets: dict[str, Any] = {}
        for k, v in fields.items():
            if k not in allowed or v is None:
                continue
            sets[k] = dumps(v) if k in ("tools", "hermes_toolsets") else (int(v) if isinstance(v, bool) else v)
        if sets:
            sets["updated_at"] = now_iso()
            cols = ", ".join(f"{k} = ?" for k in sets)
            self.state.db.execute(f"UPDATE agents SET {cols} WHERE id = ?", (*sets.values(), agent_id))
            self.state.audit.record("user", "agent.configure", agent_id, "updated", fields=list(sets))
        agent = self.get(agent_id)
        if not agent:
            raise KeyError(agent_id)
        self.state.bus.publish("agent.updated", agent)
        return agent

    def history(self, agent_id: str, limit: int = 30) -> list[dict[str, Any]]:
        return self.state.tasks.list(limit=limit) if agent_id == "*" else [
            self.state.tasks._decode(r) for r in self.state.db.query(  # noqa: SLF001
                "SELECT * FROM tasks WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?", (agent_id, limit))
        ]

    def tool_usage(self, agent_id: str) -> list[dict[str, Any]]:
        rows = self.state.db.query(
            "SELECT e.type, e.data FROM task_events e JOIN tasks t ON t.id = e.task_id "
            "WHERE t.agent_id = ? AND e.type IN ('tool.completed','tool.failed','tool.denied') ORDER BY e.id DESC LIMIT 2000",
            (agent_id,),
        )
        counts: dict[str, dict[str, int]] = {}
        for r in rows:
            tool = (loads(r["data"], {}) or {}).get("tool") or "unknown"
            c = counts.setdefault(tool, {"completed": 0, "failed": 0, "denied": 0})
            c[r["type"].split(".")[1]] += 1
        return [{"tool": k, **v} for k, v in sorted(counts.items(), key=lambda kv: -sum(kv[1].values()))]

    def choose_runtime(self, agent: dict[str, Any], override: str | None = None) -> str:
        pref = override or (agent.get("runtime_pref") if agent.get("runtime_pref") != "auto" else None) \
            or self.state.prefs.get("agents.runtime") or "auto"
        return pref  # auto | hermes | native

    def submit(self, agent_id: str, prompt: str, *, conversation_id: str | None = None, runtime: str | None = None,
               automation_run_id: str | None = None, title: str | None = None) -> dict[str, Any]:
        self.state.approvals.ensure_not_halted()
        agent = self.get(agent_id)
        if not agent:
            raise KeyError(f"Unknown agent {agent_id}")
        if not agent["enabled"]:
            raise ValueError(f"Agent {agent['name']} is disabled")
        task = self.state.tasks.create(title or prompt.strip().splitlines()[0][:100] or "Agent task", "agent", input=prompt,
                                       agent_id=agent_id, conversation_id=conversation_id, automation_run_id=automation_run_id)
        self.state.tasks.add_event(task["id"], "task.created", f"Assigned to {agent['name']}", data={"agent": agent_id})
        mode = self.choose_runtime(agent, runtime)

        async def work() -> str:
            return await self._execute(task["id"], agent, prompt, conversation_id, mode)

        self.state.tasks.start(task["id"], work)
        return task

    async def run_now(self, agent_id: str, prompt: str, **kwargs: Any) -> dict[str, Any]:
        """Run an agent task inline (used by automations to chain steps). Returns the finished task."""
        agent = self.get(agent_id)
        if not agent:
            raise KeyError(agent_id)
        task = self.state.tasks.create(kwargs.get("title") or prompt[:100], "agent", input=prompt, agent_id=agent_id,
                                       automation_run_id=kwargs.get("automation_run_id"))
        mode = self.choose_runtime(agent, kwargs.get("runtime"))
        return await self.state.tasks.run_inline(task["id"], lambda: self._execute(task["id"], agent, prompt, None, mode))

    async def _execute(self, task_id: str, agent: dict[str, Any], prompt: str, conversation_id: str | None, mode: str) -> str:
        st = self.state
        history = self._history(conversation_id) if conversation_id else []
        result: str
        if mode in ("auto", "hermes"):
            try:
                hs = await st.hermes.status()
                if not hs["transport"]:
                    raise HermesUnavailable("Hermes is not available")
                st.tasks.add_event(task_id, "runtime.selected", f"Running on Hermes ({hs['transport']})", data={"runtime": "hermes", "transport": hs["transport"]})
                session = self._hermes_session(conversation_id)
                result = await st.hermes.run(st, task_id, agent, prompt, session_id=session)
            except HermesUnavailable as exc:
                if mode == "hermes":
                    raise
                st.tasks.add_event(task_id, "runtime.fallback", "Hermes unavailable — using NEXUS native runtime", detail=str(exc))
                result = await run_native(st, task_id, agent, prompt, history)
        else:
            st.tasks.add_event(task_id, "runtime.selected", "Running on NEXUS native runtime", data={"runtime": "native"})
            result = await run_native(st, task_id, agent, prompt, history)
        if conversation_id:
            mid = new_id("msg")
            task = st.tasks.get(task_id) or {}
            st.db.execute(
                "INSERT INTO messages(id, conversation_id, role, content, model, status, task_id, metadata, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (mid, conversation_id, "assistant", result, (task.get("metadata") or {}).get("model") or task.get("runtime"),
                 "complete", task_id, dumps({"agent_id": agent["id"], "runtime": task.get("runtime")}), now_iso()),
            )
            st.db.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now_iso(), conversation_id))
            st.bus.publish("conversation.message", {"conversation_id": conversation_id, "message_id": mid, "task_id": task_id})
        return result

    def _history(self, conversation_id: str, limit: int = 12) -> list[dict[str, Any]]:
        rows = self.state.db.query(
            "SELECT role, content FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') AND status = 'complete' "
            "ORDER BY created_at DESC LIMIT ?", (conversation_id, limit + 1))
        rows.reverse()
        # The newest user message is the prompt itself; exclude it from history.
        if rows and rows[-1]["role"] == "user":
            rows = rows[:-1]
        return [{"role": r["role"], "content": r["content"]} for r in rows]

    def _hermes_session(self, conversation_id: str | None) -> str | None:
        if not conversation_id:
            return None
        row = self.state.db.query_one("SELECT hermes_session_id FROM conversations WHERE id = ?", (conversation_id,))
        if row and row["hermes_session_id"]:
            return row["hermes_session_id"]
        sid = f"nexus-{conversation_id}"
        self.state.db.execute("UPDATE conversations SET hermes_session_id = ? WHERE id = ?", (sid, conversation_id))
        return sid
