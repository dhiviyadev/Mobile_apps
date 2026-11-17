"""Projects, phone push notifications, web access and Apple apps (Calendar, Reminders, Mail)."""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from ..app_state import AppState
from ..integrations.apple import AppleUnavailable
from ..integrations.web import WebBlocked, WebDisabled
from ..brokers.service import BrokerError
from ..markets.service import SOURCES, MarketError
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
        st.markets.warm([w["symbol"] for w in watch])
    return {"enabled": st.markets.enabled, "watchlist": [{**w, "quote": quotes.get(w["symbol"]), "spark": st.markets.sparkline(w["symbol"])} for w in watch],
            "portfolio": await st.markets.portfolio(), "alerts": st.markets.alerts(),
            "source": SOURCES}


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


@router.get("/markets/analysis/{symbol}")
async def markets_analysis(symbol: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return await st.markets.analysis(symbol)
    except MarketError as exc:
        raise _market(exc) from exc


@router.get("/markets/live/{symbol}")
async def markets_live(symbol: str, range: str = "6mo", st: AppState = Depends(get_state)) -> dict[str, Any]:  # noqa: A002
    """Latest price and last candles for an open chart; cheap to call every few seconds (answers come from short caches)."""
    try:
        return await st.markets.live(symbol, range)
    except MarketError as exc:
        raise _market(exc) from exc


@router.get("/markets/overview")
async def markets_overview_today(st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return await st.markets.overview()
    except MarketError as exc:
        raise _market(exc) from exc


@router.get("/markets/scan")
async def markets_scan(st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    try:
        st.markets._require()  # noqa: SLF001
        return await st.markets.scan()
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


# -- broker (real money) ----------------------------------------------------------
def _broker(exc: Exception) -> HTTPException:
    return HTTPException(403 if isinstance(exc, EmergencyStopActive) else 400, str(exc))


@router.get("/broker")
async def broker_status(st: AppState = Depends(get_state)) -> dict[str, Any]:
    return await st.broker.status()


@router.post("/broker/zerodha/login")
async def broker_login(st: AppState = Depends(get_state)) -> dict[str, Any]:
    """Start a Zerodha login: returns the sign-in address and, on a Mac, opens it in the default browser."""
    try:
        url = st.broker.begin_login()
    except BrokerError as exc:
        raise _broker(exc) from exc
    opened = False
    from ..config import IS_MACOS

    if IS_MACOS:
        import asyncio

        proc = await asyncio.create_subprocess_exec("/usr/bin/open", url)
        opened = (await proc.wait()) == 0
    return {"url": url, "opened": opened}


_CALLBACK_PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>NEXUS</title><style>
body{{font:16px -apple-system,system-ui,sans-serif;background:#14161b;color:#e8eaee;display:grid;place-items:center;height:100vh;margin:0}}
div{{max-width:420px;text-align:center;line-height:1.5}}h1{{font-size:20px}}p{{color:#aeb3bc}}</style></head>
<body><div><h1>{title}</h1><p>{body}</p></div></body></html>"""


@router.get("/broker/zerodha/callback", response_class=HTMLResponse)
async def broker_callback(request_token: str = "", state: str = "", status: str = "", st: AppState = Depends(get_state)) -> HTMLResponse:
    import html

    if status and status != "success":
        return HTMLResponse(_CALLBACK_PAGE.format(title="Login was cancelled", body="Nothing was connected. You can close this tab."), status_code=400)
    try:
        result = await st.broker.complete_login(request_token, state)
    except BrokerError as exc:
        return HTMLResponse(_CALLBACK_PAGE.format(title="Couldn't connect Zerodha", body=html.escape(str(exc))), status_code=400)
    return HTMLResponse(_CALLBACK_PAGE.format(title="Zerodha is connected",
                                              body=f"Signed in as {html.escape(str(result['user']))}. You can close this tab and go back to NEXUS."))


class DisconnectBody(BaseModel):
    forget_keys: bool = False


@router.post("/broker/disconnect")
async def broker_disconnect(body: DisconnectBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    await st.broker.disconnect(body.forget_keys)
    return {"disconnected": True}


@router.get("/broker/account")
async def broker_account(st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return await st.broker.account()
    except BrokerError as exc:
        raise _broker(exc) from exc


class LiveOrder(BaseModel):
    exchange: str
    tradingsymbol: str = Field(..., max_length=40)
    transaction_type: str
    quantity: float
    product: str
    order_type: str
    variety: str = "regular"
    validity: str = "DAY"
    price: float | None = None
    trigger_price: float | None = None


@router.post("/broker/orders/preview")
async def broker_preview(body: LiveOrder, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return await st.broker.preview(body.model_dump())
    except (BrokerError, EmergencyStopActive) as exc:
        raise _broker(exc) from exc


class LiveOrderConfirm(LiveOrder):
    confirm_code: str = Field(..., max_length=200)


@router.post("/broker/orders")
async def broker_place(body: LiveOrderConfirm, st: AppState = Depends(get_state)) -> dict[str, Any]:
    """Place a REAL order. Only accepted with the confirmation code from a preview of exactly this order."""
    data = body.model_dump()
    code = data.pop("confirm_code")
    try:
        return await st.broker.place(data, code)
    except (BrokerError, EmergencyStopActive) as exc:
        raise _broker(exc) from exc


@router.delete("/broker/orders/{order_id}")
async def broker_cancel(order_id: str, variety: str = "regular", st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return await st.broker.cancel(order_id, variety)
    except (BrokerError, EmergencyStopActive) as exc:
        raise _broker(exc) from exc


@router.get("/broker/history")
def broker_history(st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.broker.history()


# -- TradingView chart frame ------------------------------------------------------
_TV_SYMBOL = re.compile(r"^[A-Z0-9][A-Z0-9:._!&\-]{0,39}$")
_TV_INTERVALS = {"1", "5", "15", "30", "60", "240", "D", "W", "M"}
_TV_TZ = re.compile(r"^[A-Za-z_]+(/[A-Za-z0-9_+\-]+){1,2}$")
# TradingView's published embed for its Advanced Chart, exactly as documented. This page is the ONLY place their
# script runs: it is shown in a sandboxed frame with its own strict policy, so it cannot reach NEXUS's data, token or API.
_TV_PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>TradingView chart</title>
<style>html,body{{height:100%;margin:0;background:#14161b}}.tradingview-widget-container,.tradingview-widget-container__widget{{height:100%;width:100%}}</style>
</head><body><div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div>
<script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-{widget}.js" async>
{config}
</script></div></body></html>"""
_TV_WIDGETS = {"advanced-chart", "technical-analysis"}
# The built-in chart's range buttons in TradingView's terms. TradingView picks the candle size from the range
# (checked Nov 2026: 6M gives 2-hour candles, 12M daily, 60M weekly), so a range is only used where its candles
# match the built-in chart's; 1M and 6M open on daily candles at TradingView's own zoom instead.
_TV_RANGES = {"1d": ("1D", "5"), "5d": ("5D", "30"), "1mo": (None, "D"), "6mo": (None, "D"), "1y": ("12M", "D"), "5y": ("60M", "W")}
_TV_CSP = ("default-src 'none'; script-src https://s3.tradingview.com; style-src 'unsafe-inline'; img-src https: data:; "
           "frame-src https://www.tradingview-widget.com https://s.tradingview.com https://www.tradingview.com; "
           "connect-src https://*.tradingview.com https://www.tradingview-widget.com")


@router.get("/tradingview", response_class=HTMLResponse)
def tradingview_frame(symbol: str, interval: str = "D", tz: str = "Etc/UTC", widget: str = "advanced-chart", range: str = "") -> HTMLResponse:  # noqa: A002
    """A page holding TradingView's own chart widget for one symbol. Public (a frame can't send the API token) and
    holds nothing private: the only thing sent to TradingView is the symbol being viewed."""
    import json

    symbol = symbol.upper().strip()
    if not _TV_SYMBOL.match(symbol):
        raise HTTPException(400, "Invalid symbol")
    if widget not in _TV_WIDGETS:
        raise HTTPException(400, "Unknown widget")
    if widget == "technical-analysis":
        # TradingView's own summary of its indicators for the symbol: a gauge from "Strong sell" to "Strong buy".
        config: dict[str, Any] = {"interval": "1D", "width": "100%", "height": "100%", "isTransparent": False, "symbol": symbol,
                                  "showIntervalTabs": True, "displayMode": "single", "locale": "en", "colorTheme": "dark"}
    else:
        config = {"autosize": True, "symbol": symbol, "interval": interval if interval in _TV_INTERVALS else "D",
                  "timezone": tz if _TV_TZ.match(tz) else "Etc/UTC", "theme": "dark", "style": "1", "locale": "en",
                  "allow_symbol_change": True, "calendar": False, "withdateranges": True, "hide_side_toolbar": False,
                  "backgroundColor": "rgba(20, 22, 27, 1)", "support_host": "https://www.tradingview.com"}
        if range in _TV_RANGES:
            # Open on exactly the period the built-in chart shows, so the two can be compared directly.
            tv_range, config["interval"] = _TV_RANGES[range]
            if tv_range:
                config["range"] = tv_range
    # "</" can't appear (the symbol pattern forbids "<"), so the JSON can't break out of the script element.
    return HTMLResponse(_TV_PAGE.format(config=json.dumps(config), widget=widget),
                        headers={"Content-Security-Policy": _TV_CSP, "Referrer-Policy": "no-referrer", "Cache-Control": "no-store"})
