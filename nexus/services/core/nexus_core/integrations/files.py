"""Permission-checked file operations.

* read/list/search: allowed within folders that grant read.
* write: new files in write-granted folders; overwriting an existing file
  requires approval and keeps a backup copy in <data>/trash.
* delete: always requires approval; files are moved to <data>/trash, never unlinked.
* All writes are atomic (temp file + os.replace).
"""

from __future__ import annotations

import fnmatch
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from ..knowledge.extractors import SUPPORTED, ExtractionError, extract
from ..permissions.approvals import ApprovalService
from ..permissions.audit import AuditLog
from ..permissions.policy import PermissionDenied, PermissionService
from ..util import now_iso

MAX_READ_CHARS = 60_000


class FileService:
    def __init__(self, permissions: PermissionService, approvals: ApprovalService, audit: AuditLog, trash_dir: Path):
        self.permissions = permissions
        self.approvals = approvals
        self.audit = audit
        self.trash_dir = trash_dir

    def list_dir(self, path: str, actor: str = "agent") -> list[dict[str, Any]]:
        p = self.permissions.check(path, "read", actor)
        if not p.is_dir():
            raise PermissionDenied("Not a directory", str(p))
        out = []
        for child in sorted(p.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower()))[:500]:
            if child.name.startswith("."):
                continue
            try:
                st = child.stat()
            except OSError:
                continue
            out.append({"name": child.name, "path": str(child), "is_dir": child.is_dir(), "size": st.st_size, "mtime": st.st_mtime})
        self.audit.record(actor, "fs.list", str(p), "allowed")
        return out

    def read_text(self, path: str, actor: str = "agent", max_chars: int = MAX_READ_CHARS) -> dict[str, Any]:
        p = self.permissions.check(path, "read", actor)
        if not p.is_file():
            raise PermissionDenied("Not a file", str(p))
        if p.suffix.lower() in SUPPORTED and p.suffix.lower() not in {".txt", ".md", ".log"}:
            try:
                sections = extract(p, max_chars=max_chars)
                text = "\n\n".join((f"[{loc}]\n" if loc else "") + t for loc, t in sections)
            except ExtractionError as exc:
                raise PermissionDenied(f"Could not extract text: {exc}", str(p)) from exc
        else:
            raw = p.read_bytes()[: max_chars * 4]
            if b"\x00" in raw[:4096]:
                raise PermissionDenied("Binary files cannot be read as text", str(p))
            text = raw.decode("utf-8", errors="replace")
        self.audit.record(actor, "fs.read", str(p), "allowed", chars=min(len(text), max_chars))
        return {"path": str(p), "content": text[:max_chars], "truncated": len(text) > max_chars}

    def search_names(self, pattern: str, root: str | None = None, limit: int = 100, actor: str = "agent") -> list[dict[str, Any]]:
        roots = [self.permissions.check(root, "read", actor)] if root else [g.path for g in self.permissions.grants() if g.can_read]
        glob = pattern if any(c in pattern for c in "*?[") else f"*{pattern}*"
        results: list[dict[str, Any]] = []
        for r in roots:
            for dirpath, dirnames, filenames in os.walk(r):
                dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in {"node_modules", "__pycache__", ".git"}]
                for name in filenames + dirnames:
                    if fnmatch.fnmatch(name.lower(), glob.lower()):
                        full = Path(dirpath) / name
                        if self.permissions.is_allowed(full, "read"):
                            results.append({"name": name, "path": str(full), "is_dir": full.is_dir()})
                            if len(results) >= limit:
                                return results
        self.audit.record(actor, "fs.search", pattern, "allowed", results=len(results))
        return results

    async def write_text(self, path: str, content: str, actor: str = "agent", task_id: str | None = None,
                         overwrite: bool = False) -> dict[str, Any]:
        self.approvals.ensure_not_halted()
        p = self.permissions.check(path, "write", actor)
        if p.exists() and p.is_dir():
            raise PermissionDenied("Path is a directory", str(p))
        backup = None
        if p.exists():
            if not overwrite:
                raise PermissionDenied("File already exists; overwrite was not requested", str(p))
            approved = await self.approvals.request(
                "file.overwrite", f"Overwrite {p.name}",
                f"{actor} wants to replace {p} ({p.stat().st_size} bytes) with {len(content)} characters. "
                "A backup will be kept in NEXUS trash.",
                {"path": str(p), "preview": content[:2000]}, task_id=task_id,
            )
            if not approved:
                self.audit.record(actor, "fs.overwrite", str(p), "denied")
                raise PermissionDenied("Overwrite was not approved", str(p))
            backup = self._backup(p)
        p.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".nexus-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(content)
            os.replace(tmp, p)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
        self.audit.record(actor, "fs.write", str(p), "executed", bytes=len(content.encode()), backup=str(backup) if backup else None)
        return {"path": str(p), "bytes": len(content.encode()), "backup": str(backup) if backup else None}

    async def delete(self, path: str, actor: str = "agent", task_id: str | None = None) -> dict[str, Any]:
        self.approvals.ensure_not_halted()
        p = self.permissions.check(path, "write", actor)
        if not p.exists():
            raise PermissionDenied("File does not exist", str(p))
        approved = await self.approvals.request(
            "file.delete", f"Delete {p.name}", f"{actor} wants to delete {p}. It will be moved to NEXUS trash (recoverable).",
            {"path": str(p)}, task_id=task_id,
        )
        if not approved:
            self.audit.record(actor, "fs.delete", str(p), "denied")
            raise PermissionDenied("Deletion was not approved", str(p))
        dest = self._backup(p, move=True)
        self.audit.record(actor, "fs.delete", str(p), "executed", moved_to=str(dest))
        return {"path": str(p), "moved_to": str(dest)}

    def _backup(self, p: Path, move: bool = False) -> Path:
        stamp = now_iso().replace(":", "-")
        dest = self.trash_dir / stamp / p.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if move:
            shutil.move(str(p), dest)
        elif p.is_dir():
            shutil.copytree(p, dest)
        else:
            shutil.copy2(p, dest)
        return dest
