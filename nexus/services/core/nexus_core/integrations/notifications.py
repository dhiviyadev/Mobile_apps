from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ..db.database import Database
from ..events import EventBus
from ..settings_store import SettingsStore
from ..util import new_id, now_iso

if TYPE_CHECKING:
    from .macos import MacOSService


class NotificationService:
    def __init__(self, db: Database, bus: EventBus, settings: SettingsStore, macos: "MacOSService"):
        self.db = db
        self.bus = bus
        self.settings = settings
        self.macos = macos

    async def notify(self, title: str, body: str = "", level: str = "info", link: str | None = None,
                     native: bool | None = None) -> dict[str, Any]:
        nid = new_id("ntf")
        self.db.execute("INSERT INTO notifications(id, title, body, level, link, created_at) VALUES (?,?,?,?,?,?)",
                        (nid, title, body, level, link, now_iso()))
        row = self.db.query_one("SELECT * FROM notifications WHERE id = ?", (nid,))
        self.bus.publish("notification.created", row or {})
        if native if native is not None else self.settings.get("notifications.native"):
            await self.macos.notify(title, body)
        return row  # type: ignore[return-value]

    def list(self, limit: int = 50, unread_only: bool = False) -> list[dict[str, Any]]:
        where = "WHERE read = 0" if unread_only else ""
        return self.db.query(f"SELECT * FROM notifications {where} ORDER BY created_at DESC LIMIT ?", (limit,))

    def mark_read(self, notification_id: str | None = None) -> None:
        if notification_id:
            self.db.execute("UPDATE notifications SET read = 1 WHERE id = ?", (notification_id,))
        else:
            self.db.execute("UPDATE notifications SET read = 1")
        self.bus.publish("notification.read", {"id": notification_id})
