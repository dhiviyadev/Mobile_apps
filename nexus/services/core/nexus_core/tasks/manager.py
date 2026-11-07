"""Task lifecycle, persisted execution events and cancellation.

Every agent run, automation run and long job is a Task. Its timeline is a
sequence of TaskEvents recorded *as they happen* — the UI's execution timeline
is a direct view of this table, never simulated progress.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from ..db.database import Database, dumps, loads
from ..events import EventBus
from ..util import new_id, now_iso, truncate

log = logging.getLogger(__name__)

TERMINAL = {"completed", "failed", "cancelled"}
ACTIVE = {"queued", "running", "waiting_approval"}


class TaskCancelled(Exception):
    pass


class TaskManager:
    def __init__(self, db: Database, bus: EventBus, max_parallel: int = 1):
        self.db = db
        self.bus = bus
        self._running: dict[str, asyncio.Task[Any]] = {}
        self._cancel_hooks: dict[str, list[Callable[[], Awaitable[None]]]] = {}
        self._sem = asyncio.Semaphore(max(1, max_parallel))
        self._seq: dict[str, int] = {}

    # -- persistence ------------------------------------------------------
    def _decode(self, row: dict[str, Any] | None) -> dict[str, Any] | None:
        if row:
            row["metadata"] = loads(row["metadata"], {})
        return row

    def get(self, task_id: str) -> dict[str, Any] | None:
        return self._decode(self.db.query_one("SELECT * FROM tasks WHERE id = ?", (task_id,)))

    def list(self, status: str | None = None, limit: int = 50, kind: str | None = None) -> list[dict[str, Any]]:
        clauses, params = [], []
        if status == "active":
            clauses.append("status IN ('queued','running','waiting_approval')")
        elif status:
            clauses.append("status = ?")
            params.append(status)
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self.db.query(f"SELECT * FROM tasks {where} ORDER BY created_at DESC LIMIT ?", (*params, limit))
        return [self._decode(r) for r in rows]  # type: ignore[misc]

    def create(self, title: str, kind: str, input: str = "", agent_id: str | None = None,
               conversation_id: str | None = None, automation_run_id: str | None = None,
               metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        tid = new_id("tsk")
        self.db.execute(
            "INSERT INTO tasks(id, title, kind, status, agent_id, conversation_id, automation_run_id, input, metadata, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (tid, truncate(title, 140), kind, "queued", agent_id, conversation_id, automation_run_id, input, dumps(metadata or {}), now_iso()),
        )
        task = self.get(tid)
        assert task is not None
        self.bus.publish("task.updated", task)
        return task

    def update(self, task_id: str, **fields: Any) -> dict[str, Any]:
        allowed = {"status", "result", "error", "runtime", "external_ref", "started_at", "finished_at", "title"}
        sets = {k: v for k, v in fields.items() if k in allowed}
        if "metadata" in fields:
            current = self.get(task_id) or {"metadata": {}}
            merged = {**current["metadata"], **fields["metadata"]}
            sets["metadata"] = dumps(merged)
        if sets:
            cols = ", ".join(f"{k} = ?" for k in sets)
            self.db.execute(f"UPDATE tasks SET {cols} WHERE id = ?", (*sets.values(), task_id))
        task = self.get(task_id)
        if task is None:
            raise KeyError(task_id)
        self.bus.publish("task.updated", task)
        return task

    def add_event(self, task_id: str, type: str, title: str, detail: str | None = None,
                  data: dict[str, Any] | None = None) -> dict[str, Any]:
        data = data or {}
        if task_id not in self._seq:
            row = self.db.query_one("SELECT COALESCE(MAX(seq), 0) AS s FROM task_events WHERE task_id = ?", (task_id,))
            self._seq[task_id] = row["s"] if row else 0
        self._seq[task_id] += 1
        seq = self._seq[task_id]
        ts = now_iso()
        self.db.execute(
            "INSERT INTO task_events(task_id, seq, type, title, detail, data, created_at) VALUES (?,?,?,?,?,?,?)",
            (task_id, seq, type, truncate(title, 300), truncate(detail, 4000) if detail else None, dumps(data), ts),
        )
        event = {"task_id": task_id, "seq": seq, "type": type, "title": title, "detail": detail, "data": data, "created_at": ts}
        self.bus.publish("task.event", event)
        return event

    def stream_delta(self, task_id: str, text: str) -> None:
        """Token deltas are streamed live but not persisted individually (the final text is)."""
        self.bus.publish("task.delta", {"task_id": task_id, "text": text})

    def events(self, task_id: str) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM task_events WHERE task_id = ? ORDER BY seq", (task_id,))
        for r in rows:
            r["data"] = loads(r["data"], {})
        return rows

    # -- execution --------------------------------------------------------
    def start(self, task_id: str, work: Callable[[], Awaitable[str | None]], exclusive: bool = True) -> None:
        """Run `work` in the background. `exclusive` tasks share the agent semaphore (sequential by default)."""

        async def runner() -> None:
            try:
                if exclusive:
                    async with self._sem:
                        await self._run(task_id, work)
                else:
                    await self._run(task_id, work)
            except asyncio.CancelledError:
                # Cancelled while still waiting for the semaphore.
                t = self.get(task_id)
                if t and t["status"] not in TERMINAL:
                    self.update(task_id, status="cancelled", finished_at=now_iso(), error="Cancelled before start")
            finally:
                self._running.pop(task_id, None)
                self._cancel_hooks.pop(task_id, None)
                self._seq.pop(task_id, None)

        self._running[task_id] = asyncio.create_task(runner(), name=f"task:{task_id}")

    async def _run(self, task_id: str, work: Callable[[], Awaitable[str | None]]) -> None:
        task = self.get(task_id)
        if not task or task["status"] in TERMINAL:
            return
        self.update(task_id, status="running", started_at=now_iso())
        try:
            result = await work()
            self.update(task_id, status="completed", result=result, finished_at=now_iso())
            self.add_event(task_id, "task.completed", "Completed")
        except (asyncio.CancelledError, TaskCancelled):
            self.update(task_id, status="cancelled", finished_at=now_iso(), error="Cancelled")
            self.add_event(task_id, "task.cancelled", "Cancelled")
        except Exception as exc:  # noqa: BLE001 - surface every failure to the user
            log.exception("task %s failed", task_id)
            self.update(task_id, status="failed", error=str(exc) or exc.__class__.__name__, finished_at=now_iso())
            self.add_event(task_id, "task.failed", "Failed", detail=str(exc))

    async def run_inline(self, task_id: str, work: Callable[[], Awaitable[str | None]]) -> dict[str, Any]:
        """Run a task in the current coroutine (used by automations that chain actions)."""
        current = asyncio.current_task()
        if current:
            self._running[task_id] = current
        try:
            async with self._sem:
                await self._run(task_id, work)
        finally:
            self._running.pop(task_id, None)
            self._cancel_hooks.pop(task_id, None)
        return self.get(task_id)  # type: ignore[return-value]

    def on_cancel(self, task_id: str, hook: Callable[[], Awaitable[None]]) -> None:
        """Register an async hook (e.g. stop a Hermes run) that fires when the task is cancelled."""
        self._cancel_hooks.setdefault(task_id, []).append(hook)

    async def cancel(self, task_id: str) -> bool:
        task = self.get(task_id)
        if not task or task["status"] in TERMINAL:
            return False
        for hook in self._cancel_hooks.get(task_id, []):
            try:
                await hook()
            except Exception:  # noqa: BLE001
                log.exception("cancel hook failed for %s", task_id)
        running = self._running.get(task_id)
        if running and running is not asyncio.current_task():
            running.cancel()
        elif task["status"] == "queued":
            self.update(task_id, status="cancelled", finished_at=now_iso(), error="Cancelled before start")
        return True

    async def cancel_all(self) -> int:
        count = 0
        for task in self.list(status="active", limit=500):
            if await self.cancel(task["id"]):
                count += 1
        return count

    def recover(self) -> int:
        """After a restart, nothing is actually running. Mark orphaned tasks failed, honestly."""
        rows = self.db.query("SELECT id FROM tasks WHERE status IN ('queued','running','waiting_approval')")
        for r in rows:
            self.db.execute(
                "UPDATE tasks SET status='failed', error='Interrupted: NEXUS core restarted while this task was active', finished_at=? WHERE id=?",
                (now_iso(), r["id"]),
            )
        return len(rows)

    @property
    def active_count(self) -> int:
        return len(self._running)

    async def shutdown(self) -> None:
        for t in list(self._running.values()):
            t.cancel()
        if self._running:
            await asyncio.wait(list(self._running.values()), timeout=5)
