"""Folder allowlist and path permission checks.

Rules
-----
* Agents may only touch paths inside an approved folder (or the NEXUS workspace).
* Read, write and execute are granted separately per folder.
* Paths are resolved with realpath before checking, so `..` and symlinks
  cannot escape an approved folder.
* Some locations can never be approved (system dirs, the home root itself,
  credential stores, browser profiles) — NEXUS must be usable without Full
  Disk Access and must never read passwords or browser credentials.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from ..db.database import Database
from ..util import new_id, now_iso
from .audit import AuditLog

Access = Literal["read", "write", "execute"]


class PermissionDenied(Exception):
    def __init__(self, message: str, path: str | None = None):
        super().__init__(message)
        self.path = path


# Relative to $HOME. Any path inside these is always denied, even inside an approved folder.
_DENIED_HOME_SUBPATHS = [
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".config/gcloud",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    ".hermes/.env",  # Hermes secrets: never readable by NEXUS agents
    ".password-store",
    "Library/Keychains",
    "Library/Cookies",
    "Library/Mail",
    "Library/Messages",
    "Library/Safari",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Firefox",
    "Library/Application Support/BraveSoftware",
    "Library/Application Support/Microsoft Edge",
    "Library/Application Support/Arc",
    "Library/Application Support/1Password",
    "Library/Group Containers",
]
# Folders that cannot be approved as a whole (too broad).
_UNAPPROVABLE_EXACT = {"/", "/Users", "/home", "/System", "/Library", "/Applications", "/private", "/etc", "/var", "/usr", "/bin", "/sbin", "/opt", "/Volumes"}
_UNAPPROVABLE_PREFIXES = ["/System", "/usr", "/bin", "/sbin", "/etc", "/private/etc", "/private/var", "/dev", "/proc", "/sys"]
_DENIED_FILENAMES = {".env", ".env.local", ".env.production", "id_rsa", "id_ed25519", "credentials.json", "keychain-db"}


def _resolve(path: str | Path) -> Path:
    return Path(os.path.realpath(os.path.expanduser(str(path))))


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


@dataclass
class FolderGrant:
    id: str
    path: Path
    label: str
    can_read: bool
    can_write: bool
    can_execute: bool
    project: str | None = None
    builtin: bool = False


class PermissionService:
    def __init__(self, db: Database, audit: AuditLog, workspace_dir: Path, home: Path | None = None):
        self.db = db
        self.audit = audit
        self.workspace_dir = _resolve(workspace_dir)
        self.home = _resolve(home or Path.home())
        self._denied = [self.home / p for p in _DENIED_HOME_SUBPATHS]

    # -- folder management -------------------------------------------------
    def validate_approvable(self, path: str | Path) -> Path:
        p = _resolve(path)
        if not p.exists() or not p.is_dir():
            raise PermissionDenied("Folder does not exist or is not a directory", str(p))
        if str(p) in _UNAPPROVABLE_EXACT or p == self.home or p == Path(p.anchor):
            raise PermissionDenied("This folder is too broad to approve. Choose a specific project folder.", str(p))
        if any(str(p) == pre or str(p).startswith(pre + "/") for pre in _UNAPPROVABLE_PREFIXES):
            raise PermissionDenied("System folders cannot be approved.", str(p))
        if p == self.home / "Library" or self._hits_denylist(p):
            raise PermissionDenied("This location holds credentials or private app data and cannot be approved.", str(p))
        # Approving a parent of a denied location is allowed; the denied subpaths stay blocked by check().
        return p

    def add_folder(self, path: str, label: str | None = None, project: str | None = None, can_read: bool = True,
                   can_write: bool = False, can_execute: bool = False, index_enabled: bool = True) -> dict[str, Any]:
        p = self.validate_approvable(path)
        existing = self.db.query_one("SELECT * FROM folders WHERE path = ?", (str(p),))
        if existing:
            raise PermissionDenied("Folder is already approved", str(p))
        fid = new_id("fld")
        self.db.execute(
            "INSERT INTO folders(id, path, label, project, can_read, can_write, can_execute, index_enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (fid, str(p), label or p.name, project, int(can_read), int(can_write), int(can_execute), int(index_enabled), now_iso()),
        )
        self.audit.record("user", "folder.approve", str(p), "granted", read=can_read, write=can_write, execute=can_execute)
        return self.get_folder(fid)  # type: ignore[return-value]

    def update_folder(self, folder_id: str, **fields: Any) -> dict[str, Any]:
        allowed = {"label", "project", "can_read", "can_write", "can_execute", "index_enabled"}
        sets = {k: (int(v) if isinstance(v, bool) else v) for k, v in fields.items() if k in allowed and v is not None}
        if sets:
            cols = ", ".join(f"{k} = ?" for k in sets)
            self.db.execute(f"UPDATE folders SET {cols} WHERE id = ?", (*sets.values(), folder_id))
            folder = self.get_folder(folder_id)
            self.audit.record("user", "folder.update", folder["path"] if folder else folder_id, "updated", **sets)
        folder = self.get_folder(folder_id)
        if not folder:
            raise KeyError(folder_id)
        return folder

    def remove_folder(self, folder_id: str) -> None:
        folder = self.get_folder(folder_id)
        if not folder:
            raise KeyError(folder_id)
        self.db.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
        self.audit.record("user", "folder.revoke", folder["path"], "revoked")

    def get_folder(self, folder_id: str) -> dict[str, Any] | None:
        return self.db.query_one("SELECT * FROM folders WHERE id = ?", (folder_id,))

    def list_folders(self) -> list[dict[str, Any]]:
        return self.db.query("SELECT * FROM folders ORDER BY label")

    def grants(self) -> list[FolderGrant]:
        grants = [
            FolderGrant("workspace", self.workspace_dir, "NEXUS Workspace", True, True, False, builtin=True)
        ]
        for f in self.list_folders():
            grants.append(
                FolderGrant(f["id"], Path(f["path"]), f["label"], bool(f["can_read"]), bool(f["can_write"]),
                            bool(f["can_execute"]), f["project"])
            )
        return grants

    # -- checks -------------------------------------------------------------
    def _hits_denylist(self, p: Path) -> bool:
        if p.name in _DENIED_FILENAMES:
            return True
        return any(_is_within(p, d) for d in self._denied)

    def grant_for(self, path: str | Path) -> FolderGrant | None:
        p = _resolve(path)
        best: FolderGrant | None = None
        for g in self.grants():
            if _is_within(p, g.path) and (best is None or len(str(g.path)) > len(str(best.path))):
                best = g
        return best

    def check(self, path: str | Path, access: Access, actor: str = "agent") -> Path:
        """Return the resolved path if `actor` may perform `access` on it, else raise PermissionDenied."""
        p = _resolve(path)
        if self._hits_denylist(p):
            self.audit.record(actor, f"fs.{access}", str(p), "denied", reason="protected location")
            raise PermissionDenied("Access to this protected location is never allowed.", str(p))
        grant = self.grant_for(p)
        if grant is None:
            self.audit.record(actor, f"fs.{access}", str(p), "denied", reason="outside approved folders")
            raise PermissionDenied("Path is outside all approved folders.", str(p))
        ok = {"read": grant.can_read, "write": grant.can_write, "execute": grant.can_execute}[access]
        if not ok:
            self.audit.record(actor, f"fs.{access}", str(p), "denied", reason=f"no {access} permission on {grant.label}")
            raise PermissionDenied(f"'{grant.label}' does not grant {access} permission.", str(p))
        return p

    def is_allowed(self, path: str | Path, access: Access) -> bool:
        try:
            p = _resolve(path)
            if self._hits_denylist(p):
                return False
            g = self.grant_for(p)
            return bool(g and {"read": g.can_read, "write": g.can_write, "execute": g.can_execute}[access])
        except OSError:
            return False
