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

from .. import __version__
from ..app_state import AppState
from ..config import Settings
from ..security import host_allowed, token_matches
from . import routes_ai, routes_data, routes_system

log = logging.getLogger(__name__)

PUBLIC_PATHS = {"/health"}


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
        # DNS-rebinding protection: only loopback Host headers are accepted.
        if not host_allowed(request.headers.get("host")):
            return JSONResponse({"detail": "Host not allowed"}, status_code=421)
        if request.method == "OPTIONS" or request.url.path in PUBLIC_PATHS:
            return await call_next(request)
        if settings.require_auth and (request.url.path.startswith("/api") or request.url.path in ("/docs", "/openapi.json")):
            auth = request.headers.get("authorization", "")
            token = auth[7:] if auth.lower().startswith("bearer ") else request.headers.get("x-nexus-token")
            state: AppState = request.app.state.nexus
            if not token_matches(state.token, token):
                return JSONResponse({"detail": "Unauthorized"}, status_code=401)
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

    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        state: AppState = websocket.app.state.nexus
        if not host_allowed(websocket.headers.get("host")):
            await websocket.close(code=4403)
            return
        origin = websocket.headers.get("origin")
        if origin and origin not in settings.cors_origins:
            await websocket.close(code=4403)
            return
        if settings.require_auth and not token_matches(state.token, websocket.query_params.get("token")):
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
