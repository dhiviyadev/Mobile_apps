"""Projects, phone push notifications, web access and Apple apps (Calendar, Reminders, Mail)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..app_state import AppState
from ..integrations.apple import AppleUnavailable
from ..integrations.web import WebBlocked, WebDisabled
from ..markets.service import MarketError
from ..permissions.approvals import EmergencyStopActive
from ..permissions.policy import PermissionDenied
from ..remote.push import PushError
from .deps import get_state, not_found

router = APIRouter(prefix="/api")


# -- projects ---------------------------------------------------------------------
class ProjectBody(BaseModel):
    name: str | None = Field(None, max_length=60)
    description: str | None = Field(None, max_length=500)
    instructions: str | None = Field(None, max_length=8000)
    color: str | None = None
    archived: bool | None = None


@router.get("/projects")
def list_projects(archived: bool = False, st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.projects.list(include_archived=archived)


@router.post("/projects")
def create_project(body: ProjectBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        project = st.projects.create(body.name or "", body.description or "", body.instructions or "", body.color)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    st.audit.record("user", "project.create", project["name"], "created")
    return project


@router.get("/projects/{project_id}")
def get_project(project_id: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    project = st.projects.get(project_id)
    if not project:
        raise not_found("Project")
    return {**project,
            "conversations": st.conversations.list(limit=30, project_id=project_id),
            "memories": st.memory.list(project_id=project_id, limit=100),
            "folders": [f for f in st.permissions.list_folders() if f.get("project") == project["name"]],
            "automations": [a for a in st.automations.list() if a.get("project_id") == project_id]}


@router.patch("/projects/{project_id}")
def patch_project(project_id: str, body: ProjectBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return st.projects.update(project_id, **body.model_dump())
    except KeyError:
        raise not_found("Project") from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/projects/{project_id}")
def delete_project(project_id: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        st.projects.delete(project_id)
    except KeyError:
        raise not_found("Project") from None
    st.audit.record("user", "project.delete", project_id, "deleted")
    return {"deleted": project_id}


# -- phone push notifications -----------------------------------------------------
class PushSubscription(BaseModel):
    endpoint: str = Field(..., max_length=1000)
    p256dh: str = Field(..., max_length=200)
    auth: str = Field(..., max_length=100)


class PushUnsubscribe(BaseModel):
    endpoint: str | None = Field(None, max_length=1000)


def _device(request: Request) -> str:
    device_id = getattr(request.state, "device_id", None)
    if not device_id:
        raise HTTPException(400, "Notifications are set up from the NEXUS app on your phone.")
    return device_id


@router.get("/push")
def push_status(request: Request, st: AppState = Depends(get_state)) -> dict[str, Any]:
    device_id = getattr(request.state, "device_id", None)
    return {"enabled": st.push.enabled, "public_key": st.push.public_key() if st.push.enabled else None,
            "subscriptions": st.push.count(device_id)}


@router.post("/push/subscribe")
def push_subscribe(body: PushSubscription, request: Request, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return st.push.subscribe(_device(request), body.endpoint, body.p256dh, body.auth)
    except PushError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/push/unsubscribe")
def push_unsubscribe(body: PushUnsubscribe, request: Request, st: AppState = Depends(get_state)) -> dict[str, Any]:
    device_id = getattr(request.state, "device_id", None)
    if not device_id and not body.endpoint:
        return {"removed": st.push.unsubscribe()}  # the Mac can clear every phone's subscription
    return {"removed": st.push.unsubscribe(body.endpoint, device_id)}


@router.post("/push/test")
async def push_test(request: Request, st: AppState = Depends(get_state)) -> dict[str, Any]:
    device_id = getattr(request.state, "device_id", None)
    return await st.push.send("NEXUS", "Notifications are working.", device_id=device_id, tag="test")


# -- web access -------------------------------------------------------------------
class WebSearchBody(BaseModel):
    query: str = Field(..., min_length=1, max_length=300)


@router.post("/web/search")
async def web_search(body: WebSearchBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    """Lets the user check that web search works after turning it on."""
    try:
        return await st.web.search(body.query, actor="user")
    except (WebDisabled, WebBlocked) as exc:
        raise HTTPException(400, str(exc)) from exc


# -- Apple apps -------------------------------------------------------------------
def _apple_error(exc: Exception) -> HTTPException:
    if isinstance(exc, (PermissionDenied, EmergencyStopActive)):
        return HTTPException(403, str(exc))
    return HTTPException(400, str(exc))


@router.get("/apple")
def apple_status(st: AppState = Depends(get_state)) -> dict[str, Any]:
    return st.apple.status()


@router.get("/apple/calendar")
async def calendar(days: int = 1, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return await st.apple.events(days, actor="user")
    except AppleUnavailable as exc:
        raise _apple_error(exc) from exc


@router.get("/apple/reminders")
async def reminders(st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return await st.apple.reminders(actor="user")
    except AppleUnavailable as exc:
        raise _apple_error(exc) from exc


class ReminderBody(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    notes: str = Field("", max_length=2000)
    due: str | None = None


@router.post("/apple/reminders")
async def add_reminder(body: ReminderBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    """The user adding a reminder themselves on the Mac: no extra approval prompt."""
    try:
        return await st.apple.create_reminder(body.title, body.notes, body.due, actor="user", require_approval=False)
    except (AppleUnavailable, ValueError, PermissionDenied, EmergencyStopActive) as exc:
        raise _apple_error(exc) from exc


# -- markets ----------------------------------------------------------------------
def _market(exc: MarketError) -> HTTPException:
    return HTTPException(400, str(exc))


@router.get("/markets")
async def markets_overview(st: AppState = Depends(get_state)) -> dict[str, Any]:
    """Watchlist with latest quotes, the practice account and alerts, in one call."""
    watch = st.markets.watchlist()
    quotes: dict[str, Any] = {}
    if st.markets.enabled and watch:
        quotes = await st.markets.quotes([w["symbol"] for w in watch])
    return {"enabled": st.markets.enabled, "watchlist": [{**w, "quote": quotes.get(w["symbol"])} for w in watch],
            "portfolio": await st.markets.portfolio(), "alerts": st.markets.alerts(),
            "source": "Yahoo Finance (unofficial, may be delayed)"}


@router.get("/markets/search")
async def markets_search(q: str, st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    try:
        return await st.markets.search(q)
    except MarketError as exc:
        raise _market(exc) from exc


@router.get("/markets/history/{symbol}")
async def markets_history(symbol: str, range: str = "6mo", st: AppState = Depends(get_state)) -> dict[str, Any]:  # noqa: A002
    try:
        return await st.markets.history(symbol, range)
    except MarketError as exc:
        raise _market(exc) from exc


class WatchBody(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=15)


@router.post("/markets/watchlist")
async def markets_watch(body: WatchBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return await st.markets.watch(body.symbol)
    except MarketError as exc:
        raise _market(exc) from exc


@router.delete("/markets/watchlist/{symbol}")
def markets_unwatch(symbol: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        st.markets.unwatch(symbol)
    except MarketError as exc:
        raise _market(exc) from exc
    return {"removed": symbol.upper()}


class OrderBody(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=15)
    side: str
    quantity: float


@router.post("/markets/orders")
async def markets_order(body: OrderBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    """A practice order: pretend money, filled at the latest real price. Never a real trade."""
    try:
        st.approvals.ensure_not_halted()
        return await st.markets.order(body.symbol, body.side, body.quantity)
    except MarketError as exc:
        raise _market(exc) from exc
    except EmergencyStopActive as exc:
        raise HTTPException(403, str(exc)) from exc


@router.get("/markets/orders")
def markets_orders(limit: int = 50, st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.markets.orders(limit)


class ResetBody(BaseModel):
    cash: float = 100_000
    currency: str = "USD"


@router.post("/markets/account/reset")
def markets_reset(body: ResetBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return st.markets.reset_account(body.cash, body.currency)
    except MarketError as exc:
        raise _market(exc) from exc


class AlertBody(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=15)
    direction: str
    price: float


@router.post("/markets/alerts")
def markets_add_alert(body: AlertBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return st.markets.add_alert(body.symbol, body.direction, body.price)
    except MarketError as exc:
        raise _market(exc) from exc


@router.delete("/markets/alerts/{alert_id}")
def markets_remove_alert(alert_id: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    st.markets.remove_alert(alert_id)
    return {"removed": alert_id}
