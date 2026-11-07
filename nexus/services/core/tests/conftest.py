"""Test fixtures. External services (Ollama, Hermes) are replaced by scripted
in-process fakes built on httpx.MockTransport that follow the documented wire
formats. Production code always talks to the real services."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from nexus_core.api.app import create_app
from nexus_core.config import Settings


class FakeOllama:
    """Scripted Ollama: each /api/chat call pops the next scripted reply."""

    def __init__(self) -> None:
        self.models = [
            {"name": "qwen3:8b", "size": 5_200_000_000, "details": {"family": "qwen3", "parameter_size": "8.2B",
                                                                   "quantization_level": "Q4_K_M", "families": ["qwen3"]}},
            {"name": "nomic-embed-text:latest", "size": 274_000_000, "details": {"family": "nomic-bert", "families": ["nomic-bert"]}},
        ]
        self.running: list[dict[str, Any]] = []
        self.replies: list[dict[str, Any]] = []
        self.requests: list[dict[str, Any]] = []
        self.online = True

    def script(self, *replies: dict[str, Any]) -> None:
        self.replies.extend(replies)

    def handler(self, request: httpx.Request) -> httpx.Response:
        if not self.online:
            raise httpx.ConnectError("connection refused")
        path = request.url.path
        body = json.loads(request.content or b"{}") if request.method == "POST" else {}
        self.requests.append({"path": path, "body": body})
        if path == "/api/version":
            return httpx.Response(200, json={"version": "0.12.0-fake"})
        if path == "/api/tags":
            return httpx.Response(200, json={"models": self.models})
        if path == "/api/ps":
            return httpx.Response(200, json={"models": self.running})
        if path == "/api/generate":
            name = body["model"]
            if body.get("keep_alive") == 0:
                self.running = [m for m in self.running if m["name"] != name]
            elif not any(m["name"] == name for m in self.running):
                size = next(m["size"] for m in self.models if m["name"] == name)
                self.running.append({"name": name, "size": size, "size_vram": size})
            return httpx.Response(200, json={"model": name, "done": True, "load_duration": 1_500_000_000})
        if path == "/api/embed":
            inputs = body["input"]
            vecs = [[float(len(t) % 7), float("invoice" in t.lower()), 1.0] for t in inputs]
            return httpx.Response(200, json={"embeddings": vecs})
        if path == "/api/chat":
            reply = self.replies.pop(0) if self.replies else {"content": "Hello from fake Ollama."}
            lines = []
            content = reply.get("content", "")
            for i in range(0, len(content), 5):
                lines.append({"message": {"role": "assistant", "content": content[i:i + 5]}, "done": False})
            if reply.get("tool_calls"):
                lines.append({"message": {"role": "assistant", "content": "", "tool_calls": reply["tool_calls"]}, "done": False})
            lines.append({"message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop",
                          "total_duration": 900_000_000, "load_duration": 10_000_000, "prompt_eval_count": 42,
                          "eval_count": 30, "eval_duration": 600_000_000})
            return httpx.Response(200, content="\n".join(json.dumps(x) for x in lines).encode(),
                                  headers={"content-type": "application/x-ndjson"})
        return httpx.Response(404, json={"error": "not found"})


@pytest.fixture
def fake_ollama() -> FakeOllama:
    return FakeOllama()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    s = Settings()
    s.data_dir = tmp_path / "data"
    s.hermes_bin = None
    s.hermes_mode = "auto"
    s.hermes_home = tmp_path / "hermes-home"
    s.hermes_api_url = "http://hermes.test"
    s.start_background = False
    return s


@pytest.fixture
def client(settings: Settings, fake_ollama: FakeOllama) -> Iterator[TestClient]:
    app = create_app(settings)
    with TestClient(app, base_url="http://127.0.0.1") as c:
        st = app.state.nexus
        st.ollama._client = httpx.AsyncClient(base_url="http://ollama.test", transport=httpx.MockTransport(fake_ollama.handler))
        # Hermes "not running" by default.
        st.hermes.transport = httpx.MockTransport(lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused")))
        c.headers["Authorization"] = f"Bearer {st.token}"
        c.app_state = st  # type: ignore[attr-defined]
        yield c


@pytest.fixture
def st(client: TestClient) -> Any:
    return client.app_state  # type: ignore[attr-defined]


def read_sse(resp: httpx.Response) -> list[dict[str, Any]]:
    events = []
    for line in resp.text.splitlines():
        if line.startswith("data:"):
            events.append(json.loads(line[5:].strip()))
    return events


def wait_task(client: TestClient, task_id: str, timeout: float = 10) -> dict[str, Any]:
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        t = client.get(f"/api/tasks/{task_id}").json()
        if t["status"] in ("completed", "failed", "cancelled"):
            return t
        time.sleep(0.05)
    raise AssertionError(f"task {task_id} did not finish: {t}")


def arun(client: TestClient, fn: Any, *args: Any) -> Any:
    """Run an async callable on the app's own event loop (where background tasks live)."""
    return client.portal.call(fn, *args)  # type: ignore[attr-defined]
