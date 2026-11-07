from __future__ import annotations

from typing import Any

from ..db.database import Database, dumps, loads
from ..events import EventBus
from ..util import now_iso


class AuditLog:
    """Append-only record of every permission decision and side-effecting action."""

    def __init__(self, db: Database, bus: EventBus):
        self.db = db
        self.bus = bus

    def record(self, actor: str, action: str, target: str | None, decision: str, **detail: Any) -> None:
        ts = now_iso()
        self.db.execute(
            "INSERT INTO audit_log(ts, actor, action, target, decision, detail) VALUES (?,?,?,?,?,?)",
            (ts, actor, action, target, decision, dumps(detail)),
        )
        self.bus.publish("audit.recorded", {"ts": ts, "actor": actor, "action": action, "target": target, "decision": decision})

    def list(self, limit: int = 200, action: str | None = None) -> list[dict[str, Any]]:
        if action:
            rows = self.db.query("SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ?", (action, limit))
        else:
            rows = self.db.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,))
        for r in rows:
            r["detail"] = loads(r["detail"], {})
        return rows
