"""Phone pairing and remote-access management.

Management endpoints are blocked for device tokens by the auth middleware
(`/api/devices` is in REMOTE_DENIED); only `/api/devices/claim` is public.
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..app_state import AppState
from ..remote.service import PairingError, tailscale_status
from .deps import get_state

router = APIRouter(prefix="/api")

_HOST_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")


@router.get("/me")
def me(request: Request) -> dict[str, Any]:
    return {"actor": request.state.actor, "remote": request.state.remote}


@router.get("/devices/remote")
def remote_status(st: AppState = Depends(get_state)) -> dict[str, Any]:
    return {"enabled": st.devices.enabled, "hostnames": sorted(st.devices.hostnames()),
            "tailscale": tailscale_status(st.settings.port), "devices": st.devices.list(),
            "mobile_app_built": st.settings.mobile_dist.is_dir()}


class RemoteBody(BaseModel):
    enabled: bool | None = None
    hostnames: list[str] | None = None


@router.patch("/devices/remote")
def set_remote(body: RemoteBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    if body.hostnames is not None:
        clean = []
        for h in body.hostnames:
            h = h.strip().lower().rstrip(".")
            if not h:
                continue
            if not _HOST_RE.match(h) or h in ("localhost",):
                raise HTTPException(400, f"'{h}' is not a valid hostname (use the full name, e.g. my-mac.tail1234.ts.net)")
            clean.append(h)
        st.prefs.set("remote.hostnames", clean)
        st.audit.record("user", "remote.hostnames", ",".join(clean), "updated")
    if body.enabled is not None:
        st.prefs.set("remote.enabled", body.enabled)
        st.audit.record("user", "remote.enable" if body.enabled else "remote.disable", None, "updated")
    return remote_status(st)


@router.post("/devices/pair")
def pair(st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return st.devices.create_pairing_code()
    except PairingError as exc:
        raise HTTPException(400, str(exc)) from exc


class ClaimBody(BaseModel):
    code: str = Field(..., min_length=4, max_length=20)
    name: str = Field("Phone", max_length=60)


@router.post("/devices/claim")
def claim(body: ClaimBody, request: Request, st: AppState = Depends(get_state)) -> dict[str, Any]:
    fwd = request.headers.get("x-forwarded-for")
    ip = fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else None)
    try:
        return st.devices.claim(body.code, body.name, ip)
    except PairingError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/devices/{device_id}/revoke")
def revoke(device_id: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    st.devices.revoke(device_id)
    return {"revoked": device_id}


@router.delete("/devices/{device_id}")
def delete(device_id: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    st.devices.delete(device_id)
    return {"deleted": device_id}
