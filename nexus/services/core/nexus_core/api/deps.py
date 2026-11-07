from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse

from ..app_state import AppState


def get_state(request: Request) -> AppState:
    return request.app.state.nexus


def not_found(what: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"{what} not found")


def sse(events: AsyncIterator[dict[str, Any]]) -> StreamingResponse:
    async def gen() -> AsyncIterator[bytes]:
        try:
            async for ev in events:
                yield f"data: {json.dumps(ev, ensure_ascii=False, default=str)}\n\n".encode()
        except Exception as exc:  # noqa: BLE001 - stream errors to the client instead of dropping the connection
            yield f"data: {json.dumps({'type': 'error', 'error': str(exc) or exc.__class__.__name__})}\n\n".encode()

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
