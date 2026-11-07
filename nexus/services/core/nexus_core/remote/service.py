"""Remote access for paired phones.

Design
------
* The core keeps binding to 127.0.0.1. Phones reach it through a reverse proxy
  running on the Mac — recommended: `tailscale serve --bg 8765`, which provides
  WireGuard encryption and a real HTTPS certificate for the Mac's tailnet name
  (HTTPS is also required for the phone's microphone and for installing the app).
* Remote access is OFF by default (`remote.enabled`). Requests carrying a device
  token are rejected while it is off, and only hostnames the user lists in
  `remote.hostnames` pass the Host check.
* A phone pairs with a one-time code shown on the Mac (8 characters, single use,
  5 minutes, rate-limited). It receives its own random token, stored here only as
  a SHA-256 hash, and revocable at any time.
* Device tokens carry a *remote* role that cannot change permissions, secrets,
  scripts, settings, agent configuration or devices (see REMOTE_DENIED).
"""

from __future__ import annotations

import hashlib
import json
import secrets
import shutil
import subprocess
import time
from collections import deque
from pathlib import Path
from typing import Any

from ..db.database import Database
from ..permissions.audit import AuditLog
from ..settings_store import SettingsStore
from ..util import new_id, now_iso

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O/1/I/L
CODE_TTL_S = 300

# (method or "*", path prefix) that a paired phone may never call.
REMOTE_DENIED: list[tuple[str, str]] = [
    ("*", "/api/secrets"),
    ("*", "/api/devices"),
    ("POST", "/api/folders"),
    ("PATCH", "/api/folders"),
    ("DELETE", "/api/folders"),
    ("POST", "/api/scripts"),
    ("DELETE", "/api/scripts"),
    ("PATCH", "/api/settings"),
    ("PATCH", "/api/agents"),
    ("PATCH", "/api/models/routing"),
    ("POST", "/api/models/benchmark"),
    ("POST", "/api/system/backup"),
    ("POST", "/api/apps/open"),
    ("POST", "/api/files/open"),
    ("*", "/docs"),
    ("*", "/openapi.json"),
]


class PairingError(Exception):
    pass


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def normalise_code(code: str) -> str:
    return "".join(ch for ch in code.upper() if ch in CODE_ALPHABET)


def remote_denied(method: str, path: str) -> bool:
    for m, prefix in REMOTE_DENIED:
        if (m == "*" or m == method) and (path == prefix or path.startswith(prefix + "/")):
            return True
    return False


class DeviceService:
    def __init__(self, db: Database, prefs: SettingsStore, audit: AuditLog):
        self.db = db
        self.prefs = prefs
        self.audit = audit
        self._claims: deque[float] = deque(maxlen=50)
        self._touch_cache: dict[str, float] = {}

    # -- settings ---------------------------------------------------------------
    @property
    def enabled(self) -> bool:
        return bool(self.prefs.get("remote.enabled"))

    def hostnames(self) -> set[str]:
        return {h.strip().lower().rstrip(".") for h in (self.prefs.get("remote.hostnames") or []) if h and h.strip()}

    # -- pairing ----------------------------------------------------------------
    def create_pairing_code(self) -> dict[str, Any]:
        if not self.enabled:
            raise PairingError("Turn on remote access before pairing a phone.")
        raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        expires = time.time() + CODE_TTL_S
        self.db.execute("DELETE FROM pairing_codes WHERE expires_at < ? OR used = 1", (time.time(),))
        self.db.execute("INSERT INTO pairing_codes(code_hash, created_at, expires_at) VALUES (?,?,?)", (_hash(raw), now_iso(), expires))
        self.audit.record("user", "device.pairing_code", None, "created")
        return {"code": f"{raw[:4]}-{raw[4:]}", "expires_in": CODE_TTL_S}

    def claim(self, code: str, name: str, ip: str | None = None) -> dict[str, Any]:
        now = time.time()
        while self._claims and now - self._claims[0] > 300:
            self._claims.popleft()
        if len(self._claims) >= 10:
            self.audit.record(f"remote:{ip}", "device.claim", None, "denied", reason="rate limited")
            raise PairingError("Too many pairing attempts. Wait a few minutes and create a new code on your Mac.")
        self._claims.append(now)
        if not self.enabled:
            raise PairingError("Remote access is turned off on your Mac.")
        norm = normalise_code(code)
        row = self.db.query_one("SELECT * FROM pairing_codes WHERE code_hash = ?", (_hash(norm),)) if len(norm) == 8 else None
        if not row or row["used"] or row["expires_at"] < now:
            self.audit.record(f"remote:{ip}", "device.claim", None, "denied", reason="invalid or expired code")
            raise PairingError("That code is invalid or has expired. Create a new one on your Mac.")
        self.db.execute("UPDATE pairing_codes SET used = 1 WHERE code_hash = ?", (row["code_hash"],))
        token = secrets.token_urlsafe(32)
        did = new_id("dev")
        clean_name = (name or "Phone").strip()[:60] or "Phone"
        self.db.execute(
            "INSERT INTO devices(id, name, token_hash, created_at, last_seen_at, last_ip) VALUES (?,?,?,?,?,?)",
            (did, clean_name, _hash(token), now_iso(), now_iso(), ip),
        )
        self.audit.record(f"device:{clean_name}", "device.paired", did, "granted", ip=ip)
        return {"device_id": did, "name": clean_name, "token": token}

    # -- auth ---------------------------------------------------------------------
    def authenticate(self, token: str | None, ip: str | None = None) -> dict[str, Any] | None:
        if not token:
            return None
        row = self.db.query_one("SELECT id, name, revoked FROM devices WHERE token_hash = ?", (_hash(token),))
        if not row or row["revoked"]:
            return None
        last = self._touch_cache.get(row["id"], 0)
        if time.time() - last > 60:
            self._touch_cache[row["id"]] = time.time()
            self.db.execute("UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?", (now_iso(), ip, row["id"]))
        return row

    # -- management -------------------------------------------------------------
    def list(self) -> list[dict[str, Any]]:
        return self.db.query("SELECT id, name, created_at, last_seen_at, last_ip, revoked FROM devices ORDER BY created_at DESC")

    def revoke(self, device_id: str) -> None:
        self.db.execute("UPDATE devices SET revoked = 1 WHERE id = ?", (device_id,))
        self.audit.record("user", "device.revoke", device_id, "revoked")

    def delete(self, device_id: str) -> None:
        self.db.execute("DELETE FROM devices WHERE id = ?", (device_id,))
        self.audit.record("user", "device.delete", device_id, "deleted")


def _tailscale_bin() -> str | None:
    for p in (shutil.which("tailscale"), "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"):
        if p and Path(p).exists():
            return p
    return None


def tailscale_status(port: int) -> dict[str, Any]:
    """Read-only: is Tailscale installed, what is this Mac's tailnet name, and is `serve` proxying NEXUS?"""
    tb = _tailscale_bin()
    out: dict[str, Any] = {"installed": bool(tb), "dns_name": None, "online": False, "serving_nexus": False,
                           "serve_command": f"tailscale serve --bg {port}"}
    if not tb:
        return out
    try:
        r = subprocess.run([tb, "status", "--json"], capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            data = json.loads(r.stdout or "{}")
            me = data.get("Self") or {}
            out["dns_name"] = (me.get("DNSName") or "").rstrip(".") or None
            out["online"] = bool(me.get("Online"))
        r = subprocess.run([tb, "serve", "status", "--json"], capture_output=True, text=True, timeout=5)
        if r.returncode == 0 and r.stdout.strip():
            out["serving_nexus"] = f"127.0.0.1:{port}" in r.stdout or f"localhost:{port}" in r.stdout
    except (OSError, subprocess.TimeoutExpired, ValueError):
        pass
    return out
