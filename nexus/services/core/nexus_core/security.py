"""Local API authentication, host validation and macOS Keychain access.

* The API binds to 127.0.0.1 only.
* Every request needs a bearer token generated on first run and stored with
  0600 permissions in <data>/secrets/api_token. The Tauri shell reads it from
  disk and hands it to the webview; nothing else on the machine knows it
  unless it can read the user's files.
* Host header validation blocks DNS-rebinding attacks from web pages.
* Third-party credentials (cloud API keys, Hermes API key) are stored in the
  macOS Keychain, never in the database or config files.
"""

from __future__ import annotations

import hmac
import logging
import os
import secrets
import subprocess
from pathlib import Path

from .config import IS_MACOS

log = logging.getLogger(__name__)

KEYCHAIN_SERVICE = "com.nexus.desktop"
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1", "testserver"}


def load_or_create_token(secrets_dir: Path) -> str:
    path = secrets_dir / "api_token"
    if path.exists():
        token = path.read_text(encoding="utf-8").strip()
        if len(token) >= 32:
            return token
    token = secrets.token_urlsafe(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(token)
    os.chmod(path, 0o600)
    log.info("generated new local API token at %s", path)
    return token


def token_matches(expected: str, provided: str | None) -> bool:
    if not provided:
        return False
    return hmac.compare_digest(expected.encode(), provided.encode())


def host_allowed(host_header: str | None, extra: set[str] | None = None) -> bool:
    """Loopback names always; `extra` = remote hostnames the user approved (e.g. the Mac's tailnet name)."""
    if not host_header:
        return False
    host = host_header.strip().lower()
    if host.startswith("["):
        host = host.split("]", 1)[0] + "]"
    elif ":" in host:
        host = host.rsplit(":", 1)[0]
    return host in ALLOWED_HOSTS or bool(extra and host in extra)


# -- Keychain -------------------------------------------------------------
class Keychain:
    """Thin wrapper over /usr/bin/security. Falls back to environment variables off macOS."""

    def __init__(self, service: str = KEYCHAIN_SERVICE):
        self.service = service

    @property
    def available(self) -> bool:
        return IS_MACOS and Path("/usr/bin/security").exists()

    def get(self, account: str) -> str | None:
        env_name = "NEXUS_SECRET_" + account.upper().replace("-", "_").replace(".", "_")
        if os.environ.get(env_name):
            return os.environ[env_name]
        if not self.available:
            return None
        try:
            out = subprocess.run(
                ["/usr/bin/security", "find-generic-password", "-s", self.service, "-a", account, "-w"],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        return out.stdout.strip() if out.returncode == 0 and out.stdout.strip() else None

    def set(self, account: str, secret: str) -> bool:
        if not self.available:
            return False
        # -U updates if present. The secret is passed via argv to `security`, which is the
        # documented interface; it is not logged and the process is short-lived.
        out = subprocess.run(
            ["/usr/bin/security", "add-generic-password", "-U", "-s", self.service, "-a", account, "-w", secret],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return out.returncode == 0

    def delete(self, account: str) -> bool:
        if not self.available:
            return False
        out = subprocess.run(
            ["/usr/bin/security", "delete-generic-password", "-s", self.service, "-a", account],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return out.returncode == 0

    def has(self, account: str) -> bool:
        return self.get(account) is not None
