"""FastAPI application factory: auth + host checks, CORS, WebSocket event stream."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

from .. import __version__
from ..app_state import AppState
from ..config import Settings
from ..remote.service import remote_denied
from ..security import host_allowed, token_matches
from . import routes_ai, routes_data, routes_devices, routes_system

log = logging.getLogger(__name__)

PUBLIC_PATHS = {"/health", "/api/devices/claim"}
MOBILE_PREFIX = "/m"


class NoCacheIndexStatic(StaticFiles):
    """Hashed assets cache forever; index.html and the service worker are always revalidated."""

    async def get_response(self, path: str, scope: Scope):  # type: ignore[no-untyped-def]
        resp = await super().get_response(path, scope)
        if path in ("", ".", "index.html", "sw.js", "manifest.webmanifest") or path.endswith(".html"):
            resp.headers["Cache-Control"] = "no-cache"
        elif path.startswith("assets/"):
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp


def _client_ip(request: Request) -> str | None:
    # Behind `tailscale serve` the peer is the local proxy; it forwards the phone's address.
    fwd = request.headers.get("x-forwarded-for")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else None)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState(settings)
        app.state.nexus = state
        if settings.start_background:
            state.start_background()
        log.info("NEXUS core ready on http://%s:%s (data: %s)", settings.host, settings.port, settings.data_dir)
        yield
        log.info("NEXUS core shutting down")
        await state.shutdown()

    app = FastAPI(title="NEXUS Core", version=__version__, lifespan=lifespan, docs_url="/docs", redoc_url=None)

    @app.middleware("http")
    async def guard(request: Request, call_next):  # type: ignore[no-untyped-def]
        state: AppState = request.app.state.nexus
        remote_hosts = state.devices.hostnames() if state.devices.enabled else None
        # DNS-rebinding protection: loopback Host names, plus remote hostnames the user approved.
        if not host_allowed(request.headers.get("host"), remote_hosts):
            return JSONResponse({"detail": "Host not allowed"}, status_code=421)
        path = request.url.path
        request.state.actor = "user"
        request.state.remote = False
        if request.method == "OPTIONS" or path in PUBLIC_PATHS or path == MOBILE_PREFIX or path.startswith(MOBILE_PREFIX + "/"):
            return await call_next(request)
        if settings.require_auth and (path.startswith("/api") or path in ("/docs", "/openapi.json")):
            auth = request.headers.get("authorization", "")
            token = auth[7:] if auth.lower().startswith("bearer ") else request.headers.get("x-nexus-token")
            if not token_matches(state.token, token):
                device = state.devices.authenticate(token, _client_ip(request))
                if not device:
                    return JSONResponse({"detail": "Unauthorized"}, status_code=401)
                if not state.devices.enabled:
                    return JSONResponse({"detail": "Remote access is turned off on your Mac."}, status_code=403)
                if remote_denied(request.method, path):
                    state.audit.record(f"device:{device['name']}", "remote.request", path, "denied", method=request.method)
                    return JSONResponse({"detail": "This action is only available on your Mac."}, status_code=403)
                request.state.actor = f"device:{device['name']}"
                request.state.remote = True
        return await call_next(request)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Nexus-Token"],
        allow_credentials=False,
    )

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"status": "ok", "service": "nexus-core", "version": __version__}

    app.include_router(routes_system.router)
    app.include_router(routes_ai.router)
    app.include_router(routes_data.router)
    app.include_router(routes_devices.router)

    # The phone app (built separately). Static, public: it holds no data; the API still needs a device token.
    if settings.mobile_dist.is_dir():
        app.mount(MOBILE_PREFIX, NoCacheIndexStatic(directory=settings.mobile_dist, html=True), name="mobile")

    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        state: AppState = websocket.app.state.nexus
        remote_hosts = state.devices.hostnames() if state.devices.enabled else set()
        if not host_allowed(websocket.headers.get("host"), remote_hosts):
            await websocket.close(code=4403)
            return
        origin = websocket.headers.get("origin")
        host = (websocket.headers.get("host") or "").lower()
        # Same-origin pages (the phone app served by this core) are fine: Host was validated above.
        allowed_origins = set(settings.cors_origins) | {f"https://{h}" for h in remote_hosts} | {f"http://{host}", f"https://{host}"}
        if origin and origin not in allowed_origins:
            await websocket.close(code=4403)
            return
        token = websocket.query_params.get("token")
        if settings.require_auth and not token_matches(state.token, token):
            if not (state.devices.enabled and state.devices.authenticate(token)):
                await websocket.close(code=4401)
                return
        await websocket.accept()
        sub = state.bus.subscribe()
        await websocket.send_text(json.dumps({"topic": "hello", "data": {"version": __version__, "halted": state.approvals.halted}}))

        async def pump() -> None:
            while True:
                event = await sub.queue.get()
                await websocket.send_text(json.dumps(event, ensure_ascii=False, default=str))

        sender = asyncio.create_task(pump())
        try:
            while True:
                msg = await websocket.receive_text()  # clients only send pings
                if msg == "ping":
                    await websocket.send_text('{"topic":"pong","data":{}}')
        except WebSocketDisconnect:
            pass
        finally:
            sender.cancel()
            state.bus.unsubscribe(sub)

    return app
