"""Human-in-the-loop approvals and the emergency stop.

Anything destructive or side-effecting outside the workspace (overwrite, delete,
run a script, launch an app, start an automation that requires approval,
Hermes approval requests) creates a *proposed* action here. The caller awaits
the decision; nothing executes until the user approves it.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ..db.database import Database, dumps, loads
from ..events import EventBus
from ..util import new_id, now_iso
from .audit import AuditLog

log = logging.getLogger(__name__)


class EmergencyStopActive(Exception):
    pass


class ApprovalService:
    def __init__(self, db: Database, bus: EventBus, audit: AuditLog):
        self.db = db
        self.bus = bus
        self.audit = audit
        self._waiters: dict[str, asyncio.Future[bool]] = {}
        self.halted = False

    def _row(self, approval_id: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM approvals WHERE id = ?", (approval_id,))
        if row:
            row["payload"] = loads(row["payload"], {})
        return row

    def create(self, kind: str, title: str, detail: str = "", payload: dict[str, Any] | None = None,
               task_id: str | None = None, source: str = "nexus") -> dict[str, Any]:
        if self.halted:
            raise EmergencyStopActive("Emergency stop is active; no new actions can be proposed.")
        aid = new_id("apr")
        self.db.execute(
            "INSERT INTO approvals(id, task_id, kind, title, detail, payload, source, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (aid, task_id, kind, title, detail, dumps(payload or {}), source, "pending", now_iso()),
        )
        row = self._row(aid)
        assert row is not None
        self.bus.publish("approval.requested", row)
        self.audit.record("agent" if task_id else "system", f"approval.{kind}", title, "proposed", approval_id=aid, task_id=task_id)
        return row

    async def request(self, kind: str, title: str, detail: str = "", payload: dict[str, Any] | None = None,
                      task_id: str | None = None, source: str = "nexus", timeout: float = 600) -> bool:
        """Create an approval and wait for the user's decision. Times out as denied."""
        row = self.create(kind, title, detail, payload, task_id, source)
        fut: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._waiters[row["id"]] = fut
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._set_status(row["id"], "expired")
            return False
        except asyncio.CancelledError:
            self._set_status(row["id"], "expired")
            raise
        finally:
            self._waiters.pop(row["id"], None)

    def _set_status(self, approval_id: str, status: str) -> dict[str, Any] | None:
        self.db.execute(
            "UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
            (status, now_iso(), approval_id),
        )
        row = self._row(approval_id)
        if row:
            self.bus.publish("approval.decided", row)
        return row

    def decide(self, approval_id: str, approve: bool, actor: str = "user") -> dict[str, Any]:
        row = self._row(approval_id)
        if not row:
            raise KeyError(approval_id)
        if row["status"] != "pending":
            return row
        if approve and self.halted:
            approve = False
        row = self._set_status(approval_id, "approved" if approve else "denied")
        self.audit.record(actor, f"approval.{row['kind']}", row["title"], "approved" if approve else "denied", approval_id=approval_id)  # type: ignore[index]
        fut = self._waiters.get(approval_id)
        if fut and not fut.done():
            fut.set_result(approve)
        return row  # type: ignore[return-value]

    def pending(self) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at")
        for r in rows:
            r["payload"] = loads(r["payload"], {})
        return rows

    def history(self, limit: int = 100) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?", (limit,))
        for r in rows:
            r["payload"] = loads(r["payload"], {})
        return rows

    def expire_stale(self) -> None:
        """On startup no one is waiting for old approvals; expire them."""
        self.db.execute("UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending'", (now_iso(),))

    # -- emergency stop ---------------------------------------------------
    def halt(self) -> int:
        self.halted = True
        denied = 0
        for row in self.pending():
            self.decide(row["id"], False, actor="emergency-stop")
            denied += 1
        self.bus.publish("system.halted", {"halted": True})
        return denied

    def resume(self) -> None:
        self.halted = False
        self.audit.record("user", "emergency.resume", None, "resumed")
        self.bus.publish("system.halted", {"halted": False})

    def ensure_not_halted(self) -> None:
        if self.halted:
            raise EmergencyStopActive("Emergency stop is active. Resume NEXUS to run actions.")
