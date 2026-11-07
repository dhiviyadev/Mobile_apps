"""System, settings, secrets, approvals, notifications, audit, backup, emergency stop."""

from __future__ import annotations

import shutil
import tarfile
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..app_state import AppState
from ..models.ollama import OllamaError
from ..system.macos_metrics import hardware
from .deps import get_state, not_found

router = APIRouter(prefix="/api")


@router.get("/bootstrap")
async def bootstrap(st: AppState = Depends(get_state)) -> dict[str, Any]:
    """Everything the Home workspace needs in one round trip."""
    try:
        installed = await st.ollama.list_models()
        running = await st.ollama.running_models()
        ollama_ok = True
    except OllamaError:
        installed, running, ollama_ok = [], [], False
    default_model = None
    if ollama_ok and installed:
        try:
            default_model = await st.router.resolve("general")
        except Exception:  # noqa: BLE001
            default_model = None
    return {
        "profile": {"name": st.prefs.get("profile.name") or ""},
        "hardware": hardware(),
        "halted": st.approvals.halted,
        "ollama": {"online": ollama_ok, "installed": len(installed), "running": [m.get("name") for m in running],
                   "default_model": default_model},
        "hermes": await st.hermes.status(cached=True),
        "tasks": {"recent": st.tasks.list(limit=8), "active": st.tasks.list(status="active", limit=20)},
        "agents": st.agents.list(),
        "automations": {"upcoming": st.automations.upcoming(), "count": len(st.automations.list())},
        "conversations": st.conversations.list(limit=6),
        "approvals": st.approvals.pending(),
        "notifications": st.notifications.list(limit=10, unread_only=True),
        "knowledge": st.knowledge.stats(),
        "folders": st.permissions.list_folders(),
        "memory": {"proposed": len(st.memory.list(status="proposed"))},
        "voice": st.voice.status(),
    }


@router.get("/system/status")
async def system_status(st: AppState = Depends(get_state)) -> dict[str, Any]:
    return await st.monitor.snapshot()


@router.post("/system/emergency-stop")
async def emergency_stop(st: AppState = Depends(get_state)) -> dict[str, Any]:
    return await st.emergency_stop()


@router.post("/system/resume")
async def resume(st: AppState = Depends(get_state)) -> dict[str, Any]:
    st.approvals.resume()
    return {"halted": False}


@router.post("/system/backup")
async def backup(st: AppState = Depends(get_state)) -> dict[str, Any]:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest_dir = st.settings.backups_dir / f"nexus-{stamp}"
    dest_dir.mkdir(parents=True, exist_ok=True)
    st.db.backup_to(dest_dir / "nexus.db")
    if st.settings.workspace_dir.exists():
        shutil.copytree(st.settings.workspace_dir, dest_dir / "workspace", ignore=shutil.ignore_patterns("uploads"))
    archive = st.settings.backups_dir / f"nexus-{stamp}.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(dest_dir, arcname=dest_dir.name)
    shutil.rmtree(dest_dir)
    st.audit.record("user", "system.backup", str(archive), "executed")
    return {"path": str(archive), "bytes": archive.stat().st_size}


@router.get("/system/backups")
def list_backups(st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return [{"name": p.name, "path": str(p), "bytes": p.stat().st_size}
            for p in sorted(st.settings.backups_dir.glob("nexus-*.tar.gz"), reverse=True)]


@router.get("/audit")
def audit(limit: int = 200, action: str | None = None, st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.audit.list(limit=limit, action=action)


# -- settings & secrets -------------------------------------------------------
@router.get("/settings")
def get_settings(st: AppState = Depends(get_state)) -> dict[str, Any]:
    return {"values": st.prefs.all(), "static": {
        "data_dir": str(st.settings.data_dir), "ollama_url": st.settings.ollama_url, "hermes_mode": st.settings.hermes_mode,
        "hermes_api_url": st.settings.hermes_api_url, "workspace_dir": str(st.settings.workspace_dir),
        "scripts_dir": str(st.settings.scripts_dir), "port": st.settings.port}}


class SettingsPatch(BaseModel):
    values: dict[str, Any]


@router.patch("/settings")
def patch_settings(body: SettingsPatch, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        values = st.prefs.update(body.values)
    except KeyError as exc:
        raise HTTPException(400, f"Unknown setting {exc}") from exc
    sensitive = [k for k in body.values if k.startswith("cloud.")]
    if sensitive:
        st.audit.record("user", "settings.cloud", ",".join(sensitive), "updated", values={k: body.values[k] for k in sensitive})
    st.bus.publish("settings.updated", {"keys": list(body.values)})
    return {"values": values}


SECRET_ACCOUNTS = {"hermes.api_key", "cloud.anthropic", "cloud.openai_compatible"}


@router.get("/secrets")
def secrets_status(st: AppState = Depends(get_state)) -> dict[str, Any]:
    return {"keychain_available": st.keychain.available, "secrets": {a: st.keychain.has(a) for a in sorted(SECRET_ACCOUNTS)}}


class SecretBody(BaseModel):
    account: str
    value: str


@router.post("/secrets")
def set_secret(body: SecretBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    if body.account not in SECRET_ACCOUNTS:
        raise HTTPException(400, "Unknown secret account")
    if not st.keychain.available:
        raise HTTPException(400, "macOS Keychain is not available; set the NEXUS_SECRET_* environment variable instead")
    if not st.keychain.set(body.account, body.value.strip()):
        raise HTTPException(500, "Keychain write failed")
    st.audit.record("user", "secret.set", body.account, "updated")
    st.hermes._status = None  # noqa: SLF001 - force re-probe
    return {"stored": True}


@router.delete("/secrets/{account}")
def delete_secret(account: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    if account not in SECRET_ACCOUNTS:
        raise HTTPException(400, "Unknown secret account")
    st.keychain.delete(account)
    st.audit.record("user", "secret.delete", account, "deleted")
    return {"deleted": True}


# -- approvals & notifications ----------------------------------------------
@router.get("/approvals")
def approvals(history: bool = False, st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.approvals.history() if history else st.approvals.pending()


class Decision(BaseModel):
    approve: bool


@router.post("/approvals/{approval_id}")
def decide(approval_id: str, body: Decision, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return st.approvals.decide(approval_id, body.approve)
    except KeyError:
        raise not_found("Approval") from None


@router.get("/notifications")
def notifications(unread: bool = False, st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.notifications.list(unread_only=unread)


@router.post("/notifications/read")
def mark_read(notification_id: str | None = None, st: AppState = Depends(get_state)) -> dict[str, Any]:
    st.notifications.mark_read(notification_id)
    return {"ok": True}
