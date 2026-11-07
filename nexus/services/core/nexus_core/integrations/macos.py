"""Controlled macOS integration: apps, notifications, Shortcuts and approved scripts.

There is deliberately NO general shell tool. Agents can only:
  * open an application that exists in /Applications or /System/Applications (approval required),
  * open a file/folder inside an approved folder in its default app,
  * run a Shortcut by exact name (approval required),
  * run a script registered from <data>/scripts (approval required), executed
    without a shell, with a timeout and a minimal environment.
"""

from __future__ import annotations

import asyncio
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from ..config import IS_MACOS
from ..db.database import Database
from ..permissions.approvals import ApprovalService
from ..permissions.audit import AuditLog
from ..permissions.policy import PermissionDenied, PermissionService
from ..util import new_id, now_iso

APP_DIRS = [Path("/Applications"), Path("/System/Applications"), Path("/System/Applications/Utilities"),
            Path.home() / "Applications"]
_SAFE_NAME = re.compile(r"^[\w .&+()'-]{1,80}$")


class MacOSService:
    def __init__(self, db: Database, permissions: PermissionService, approvals: ApprovalService, audit: AuditLog,
                 scripts_dir: Path, workspace_dir: Path):
        self.db = db
        self.permissions = permissions
        self.approvals = approvals
        self.audit = audit
        self.scripts_dir = scripts_dir
        self.workspace_dir = workspace_dir

    # -- applications -------------------------------------------------------
    def list_apps(self) -> list[str]:
        apps: set[str] = set()
        for d in APP_DIRS:
            if d.is_dir():
                apps.update(p.stem for p in d.glob("*.app"))
        return sorted(apps, key=str.lower)

    def _app_path(self, name: str) -> Path | None:
        for d in APP_DIRS:
            p = d / f"{name}.app"
            if p.exists():
                return p
        return None

    async def open_app(self, name: str, actor: str = "agent", task_id: str | None = None, require_approval: bool = True) -> dict[str, Any]:
        self.approvals.ensure_not_halted()
        if not _SAFE_NAME.match(name):
            raise PermissionDenied("Invalid application name")
        app = self._app_path(name)
        if not app:
            raise PermissionDenied(f"Application '{name}' was not found in /Applications")
        if require_approval and not await self.approvals.request("app.open", f"Open {name}", f"{actor} wants to launch {app}",
                                                                 {"app": str(app)}, task_id=task_id):
            self.audit.record(actor, "app.open", name, "denied")
            raise PermissionDenied("Opening the application was not approved")
        if not IS_MACOS:
            raise PermissionDenied("Opening applications is only supported on macOS")
        await _run(["/usr/bin/open", "-a", str(app)], timeout=15)
        self.audit.record(actor, "app.open", name, "executed")
        return {"opened": name}

    async def open_path(self, path: str, actor: str = "user") -> dict[str, Any]:
        p = self.permissions.check(path, "read", actor)
        if not IS_MACOS:
            raise PermissionDenied("Opening files is only supported on macOS")
        await _run(["/usr/bin/open", str(p)], timeout=15)
        self.audit.record(actor, "path.open", str(p), "executed")
        return {"opened": str(p)}

    async def reveal_in_finder(self, path: str, actor: str = "user") -> dict[str, Any]:
        p = self.permissions.check(path, "read", actor)
        if not IS_MACOS:
            raise PermissionDenied("Finder is only available on macOS")
        await _run(["/usr/bin/open", "-R", str(p)], timeout=15)
        return {"revealed": str(p)}

    # -- notifications ------------------------------------------------------
    async def notify(self, title: str, body: str) -> bool:
        if not IS_MACOS:
            return False
        # Arguments are passed via argv, never interpolated into AppleScript source.
        script = ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run"]
        try:
            await _run(["/usr/bin/osascript", *script, title[:120], body[:400]], timeout=10)
            return True
        except Exception:  # noqa: BLE001
            return False

    # -- Shortcuts ----------------------------------------------------------
    async def list_shortcuts(self) -> list[str]:
        if not IS_MACOS or not Path("/usr/bin/shortcuts").exists():
            return []
        out = await _run(["/usr/bin/shortcuts", "list"], timeout=20)
        return [line.strip() for line in out["stdout"].splitlines() if line.strip()]

    async def run_shortcut(self, name: str, input_text: str | None = None, actor: str = "agent", task_id: str | None = None) -> dict[str, Any]:
        self.approvals.ensure_not_halted()
        shortcuts = await self.list_shortcuts()
        if name not in shortcuts:
            raise PermissionDenied(f"Shortcut '{name}' does not exist")
        if not await self.approvals.request("shortcut.run", f"Run Shortcut “{name}”", f"{actor} wants to run the Shortcut {name}",
                                            {"shortcut": name, "input": (input_text or "")[:500]}, task_id=task_id):
            self.audit.record(actor, "shortcut.run", name, "denied")
            raise PermissionDenied("Running the Shortcut was not approved")
        args = ["/usr/bin/shortcuts", "run", name]
        tmp = None
        if input_text:
            tmp = self.workspace_dir / f".shortcut-input-{new_id('in')}.txt"
            tmp.write_text(input_text, encoding="utf-8")
            args += ["--input-path", str(tmp)]
        try:
            out = await _run(args, timeout=120)
        finally:
            if tmp and tmp.exists():
                tmp.unlink()
        self.audit.record(actor, "shortcut.run", name, "executed", returncode=out["returncode"])
        return out

    # -- approved scripts ---------------------------------------------------
    def list_scripts(self) -> list[dict[str, Any]]:
        return self.db.query("SELECT * FROM scripts ORDER BY name")

    def register_script(self, name: str, filename: str, description: str = "", timeout_s: int = 60) -> dict[str, Any]:
        p = (self.scripts_dir / filename).resolve()
        if p.parent != self.scripts_dir.resolve() or not p.is_file():
            raise PermissionDenied(f"Scripts must be files placed directly in {self.scripts_dir}")
        if not os.access(p, os.X_OK):
            raise PermissionDenied("Script is not executable (chmod +x)")
        if not _SAFE_NAME.match(name):
            raise PermissionDenied("Invalid script name")
        sid = new_id("scr")
        self.db.execute("INSERT INTO scripts(id, name, path, description, timeout_s, created_at) VALUES (?,?,?,?,?,?)",
                        (sid, name, str(p), description, max(1, min(timeout_s, 1800)), now_iso()))
        self.audit.record("user", "script.register", str(p), "granted")
        return self.db.query_one("SELECT * FROM scripts WHERE id = ?", (sid,))  # type: ignore[return-value]

    def remove_script(self, script_id: str) -> None:
        self.db.execute("DELETE FROM scripts WHERE id = ?", (script_id,))
        self.audit.record("user", "script.remove", script_id, "revoked")

    async def run_script(self, name: str, args: list[str] | None = None, actor: str = "agent", task_id: str | None = None,
                         require_approval: bool = True) -> dict[str, Any]:
        self.approvals.ensure_not_halted()
        row = self.db.query_one("SELECT * FROM scripts WHERE name = ?", (name,))
        if not row:
            raise PermissionDenied(f"'{name}' is not an approved script")
        args = [str(a)[:500] for a in (args or [])][:20]
        if require_approval and not await self.approvals.request(
            "script.run", f"Run script “{name}”", f"{actor} wants to run {row['path']} {' '.join(args)}",
            {"script": name, "args": args}, task_id=task_id,
        ):
            self.audit.record(actor, "script.run", name, "denied")
            raise PermissionDenied("Running the script was not approved")
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", "HOME": str(Path.home()), "LANG": "en_US.UTF-8",
               "NEXUS_WORKSPACE": str(self.workspace_dir)}
        out = await _run([row["path"], *args], timeout=row["timeout_s"], cwd=self.workspace_dir, env=env)
        self.audit.record(actor, "script.run", name, "executed", returncode=out["returncode"])
        return out


async def _run(argv: list[str], timeout: float, cwd: Path | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, stdin=asyncio.subprocess.DEVNULL,
        cwd=str(cwd) if cwd else None, env=env,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise PermissionDenied(f"Process timed out after {timeout}s") from None
    return {"returncode": proc.returncode, "stdout": stdout.decode(errors="replace")[-20000:],
            "stderr": stderr.decode(errors="replace")[-5000:]}


def run_sync(argv: list[str], timeout: float = 10) -> str | None:
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() if out.returncode == 0 else None
