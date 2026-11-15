"""Push notifications for paired phones (Web Push).

How it stays private
--------------------
* Nothing is sent unless a paired phone explicitly turns notifications on;
  `remote.push` on the Mac is a master switch.
* Messages travel through the phone maker's push service (Apple for iPhone,
  Google for Android), which is the only way to wake a phone. The payload is
  end-to-end encrypted with keys that only the phone holds (RFC 8291), so the
  push service sees that *a* notification was sent, never its contents.
* Messages are short: a title and one line. They never contain file contents.
* Subscriptions are only accepted for the known push services, so a paired
  device can't make the Mac call arbitrary addresses.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from ..db.database import Database
from ..events import EventBus
from ..permissions.audit import AuditLog
from ..settings_store import SettingsStore
from ..util import now_iso

log = logging.getLogger(__name__)

ALLOWED_PUSH_HOSTS = (".push.apple.com", "fcm.googleapis.com", ".push.services.mozilla.com", ".notify.windows.com")
# Push services require a contact in the signed token. A neutral placeholder: no personal details leave the Mac.
VAPID_SUBJECT = "mailto:push@nexus-app.invalid"


class PushError(Exception):
    pass


def endpoint_allowed(endpoint: str) -> bool:
    parts = urlsplit(endpoint)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not host or parts.port not in (None, 443):
        return False
    return any(host == h or host.endswith(h) if h.startswith(".") else host == h for h in ALLOWED_PUSH_HOSTS)


def _deliver(subscription: dict[str, Any], payload: str, vapid: Any) -> int:
    """Send one push. Returns the HTTP status (so dead subscriptions can be removed)."""
    from pywebpush import WebPushException, webpush

    try:
        resp = webpush(subscription_info=subscription, data=payload, vapid_private_key=vapid,
                       vapid_claims={"sub": VAPID_SUBJECT}, ttl=3600, timeout=10)
        return int(getattr(resp, "status_code", 201))
    except WebPushException as exc:
        return int(getattr(exc.response, "status_code", 0) or 0)


class PushService:
    def __init__(self, db: Database, prefs: SettingsStore, audit: AuditLog, secrets_dir: Path):
        self.db = db
        self.prefs = prefs
        self.audit = audit
        self.key_path = secrets_dir / "vapid_private.pem"
        self._vapid: Any = None
        self.deliver: Callable[[dict[str, Any], str, Any], int] = _deliver  # tests replace this
        self._announced: dict[str, None] = {}  # finished tasks already pushed (a task can be updated again later)

    @property
    def enabled(self) -> bool:
        return bool(self.prefs.get("remote.enabled")) and bool(self.prefs.get("remote.push"))

    # -- keys ---------------------------------------------------------------------
    def _keys(self) -> Any:
        if self._vapid is None:
            from py_vapid import Vapid02

            if self.key_path.is_file():
                self._vapid = Vapid02.from_file(str(self.key_path))
            else:
                v = Vapid02()
                v.generate_keys()
                fd = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as fh:
                    fh.write(v.private_pem())
                self._vapid = v
        return self._vapid

    def public_key(self) -> str:
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

        raw = self._keys().public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    # -- subscriptions ------------------------------------------------------------
    def subscribe(self, device_id: str, endpoint: str, p256dh: str, auth: str) -> dict[str, Any]:
        if not self.enabled:
            raise PushError("Phone notifications are turned off on your Mac.")
        if not endpoint_allowed(endpoint):
            raise PushError("That push service isn't supported.")
        if not (20 <= len(p256dh) <= 200 and 8 <= len(auth) <= 100):
            raise PushError("Invalid subscription keys.")
        self.db.execute(
            "INSERT INTO push_subscriptions(endpoint, device_id, p256dh, auth, created_at) VALUES (?,?,?,?,?) "
            "ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth",
            (endpoint, device_id, p256dh, auth, now_iso()))
        self.audit.record(f"device:{device_id}", "push.subscribe", urlsplit(endpoint).hostname, "granted")
        return {"subscribed": True}

    def unsubscribe(self, endpoint: str | None = None, device_id: str | None = None) -> int:
        if endpoint:
            cur = self.db.execute("DELETE FROM push_subscriptions WHERE endpoint = ?" + (" AND device_id = ?" if device_id else ""),
                                  (endpoint, device_id) if device_id else (endpoint,))
        elif device_id:
            cur = self.db.execute("DELETE FROM push_subscriptions WHERE device_id = ?", (device_id,))
        else:
            cur = self.db.execute("DELETE FROM push_subscriptions")
        return cur.rowcount

    def count(self, device_id: str | None = None) -> int:
        sql = ("SELECT COUNT(*) AS n FROM push_subscriptions s JOIN devices d ON d.id = s.device_id WHERE d.revoked = 0"
               + (" AND s.device_id = ?" if device_id else ""))
        return (self.db.query_one(sql, (device_id,) if device_id else ()) or {"n": 0})["n"]

    # -- sending ------------------------------------------------------------------
    async def send(self, title: str, body: str = "", *, url: str = "/m/", tag: str | None = None,
                   device_id: str | None = None) -> dict[str, int]:
        if not self.enabled:
            return {"sent": 0, "removed": 0}
        rows = self.db.query(
            "SELECT s.* FROM push_subscriptions s JOIN devices d ON d.id = s.device_id WHERE d.revoked = 0"
            + (" AND s.device_id = ?" if device_id else ""), (device_id,) if device_id else ())
        if not rows:
            return {"sent": 0, "removed": 0}
        payload = json.dumps({"title": title[:120], "body": body[:240], "url": url, "tag": tag}, ensure_ascii=False)
        vapid = self._keys()
        sent = removed = 0
        for r in rows:
            sub = {"endpoint": r["endpoint"], "keys": {"p256dh": r["p256dh"], "auth": r["auth"]}}
            try:
                status = await asyncio.to_thread(self.deliver, sub, payload, vapid)
            except Exception as exc:  # noqa: BLE001 - a push failure must never break the caller
                log.warning("push failed: %s", exc.__class__.__name__)
                continue
            if status in (404, 410):  # the phone unsubscribed or the app was removed
                self.db.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (r["endpoint"],))
                removed += 1
            elif 200 <= status < 300:
                sent += 1
            else:
                log.warning("push service answered %s", status)
        return {"sent": sent, "removed": removed}

    # -- what gets pushed ---------------------------------------------------------
    async def handle_event(self, event: dict[str, Any]) -> None:
        topic, d = event.get("topic"), event.get("data") or {}
        if topic == "approval.requested":
            await self.send("Approval needed", d.get("title") or "NEXUS is waiting for your decision.", url="/m/#tasks", tag=d.get("id"))
        elif topic == "notification.created":
            await self.send(d.get("title") or "NEXUS", d.get("body") or "", tag=d.get("id"))
        elif topic == "task.updated" and d.get("kind") == "agent" and d.get("status") in ("completed", "failed") \
                and not d.get("automation_run_id"):
            if d.get("id") in self._announced:
                return
            self._announced[d.get("id") or ""] = None
            while len(self._announced) > 500:
                self._announced.pop(next(iter(self._announced)))
            done = d["status"] == "completed"
            await self.send("Task finished" if done else "Task failed", d.get("title") or "", url="/m/#tasks", tag=d.get("id"))

    async def run_forwarder(self, bus: EventBus) -> None:
        sub = bus.subscribe({"approval.requested", "notification.created", "task.updated"})
        try:
            while True:
                event = await sub.queue.get()
                try:
                    await self.handle_event(event)
                except Exception:  # noqa: BLE001
                    log.exception("push forwarder error")
        finally:
            bus.unsubscribe(sub)
