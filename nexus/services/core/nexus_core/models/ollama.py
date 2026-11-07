"""Async client for the Ollama HTTP API (https://github.com/ollama/ollama/blob/main/docs/api.md).

Nothing is hardcoded about which models exist — everything is discovered from
/api/tags and /api/ps at runtime.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx

log = logging.getLogger(__name__)


class OllamaError(Exception):
    pass


class OllamaUnavailable(OllamaError):
    pass


@dataclass
class ChatResult:
    content: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    thinking: str = ""
    model: str = ""
    load_ms: float | None = None
    ttft_ms: float | None = None
    total_ms: float | None = None
    prompt_tokens: int | None = None
    eval_tokens: int | None = None
    tokens_per_s: float | None = None
    done_reason: str | None = None

    def metrics(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "load_ms": self.load_ms,
            "ttft_ms": self.ttft_ms,
            "total_ms": self.total_ms,
            "prompt_tokens": self.prompt_tokens,
            "eval_tokens": self.eval_tokens,
            "tokens_per_s": self.tokens_per_s,
        }


def _ns_to_ms(v: Any) -> float | None:
    return round(v / 1e6, 1) if isinstance(v, (int, float)) and v else None


def apply_final_metrics(result: ChatResult, chunk: dict[str, Any]) -> None:
    result.load_ms = _ns_to_ms(chunk.get("load_duration"))
    result.total_ms = _ns_to_ms(chunk.get("total_duration"))
    result.prompt_tokens = chunk.get("prompt_eval_count")
    result.eval_tokens = chunk.get("eval_count")
    eval_ns = chunk.get("eval_duration")
    if result.eval_tokens and eval_ns:
        result.tokens_per_s = round(result.eval_tokens / (eval_ns / 1e9), 2)
    result.done_reason = chunk.get("done_reason")


class OllamaClient:
    def __init__(self, base_url: str, timeout: float = 600):
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=httpx.Timeout(timeout, connect=3.0))

    async def close(self) -> None:
        await self._client.aclose()

    async def _get(self, path: str) -> Any:
        try:
            r = await self._client.get(path)
        except httpx.HTTPError as exc:
            raise OllamaUnavailable(f"Ollama is not reachable at {self.base_url}: {exc.__class__.__name__}") from exc
        if r.status_code >= 400:
            raise OllamaError(f"Ollama {path} returned {r.status_code}: {r.text[:300]}")
        return r.json()

    async def _post(self, path: str, body: dict[str, Any], timeout: float | None = None) -> Any:
        try:
            r = await self._client.post(path, json=body, timeout=timeout or httpx.USE_CLIENT_DEFAULT)
        except httpx.HTTPError as exc:
            raise OllamaUnavailable(f"Ollama is not reachable at {self.base_url}: {exc.__class__.__name__}") from exc
        if r.status_code >= 400:
            raise OllamaError(_error_text(r))
        return r.json() if r.content else {}

    async def version(self) -> str | None:
        try:
            data = await self._get("/api/version")
            return data.get("version")
        except OllamaError:
            return None

    async def list_models(self) -> list[dict[str, Any]]:
        data = await self._get("/api/tags")
        return data.get("models", [])

    async def running_models(self) -> list[dict[str, Any]]:
        data = await self._get("/api/ps")
        return data.get("models", [])

    async def show(self, model: str) -> dict[str, Any]:
        return await self._post("/api/show", {"model": model}, timeout=30)

    async def load(self, model: str, keep_alive: str = "10m") -> dict[str, Any]:
        """Load a model into memory without generating (empty prompt per the API docs)."""
        started = time.perf_counter()
        data = await self._post("/api/generate", {"model": model, "keep_alive": keep_alive})
        return {"model": model, "load_ms": _ns_to_ms(data.get("load_duration")),
                "wall_ms": round((time.perf_counter() - started) * 1000, 1)}

    async def unload(self, model: str) -> None:
        await self._post("/api/generate", {"model": model, "keep_alive": 0}, timeout=60)

    async def embed(self, model: str, inputs: list[str]) -> list[list[float]]:
        data = await self._post("/api/embed", {"model": model, "input": inputs}, timeout=300)
        return data.get("embeddings", [])

    async def chat_stream(self, model: str, messages: list[dict[str, Any]], *, tools: list[dict[str, Any]] | None = None,
                          options: dict[str, Any] | None = None, keep_alive: str | None = None,
                          think: bool | None = None) -> AsyncIterator[tuple[str, Any]]:
        """Yield ("delta", text) | ("thinking", text) | ("tool_calls", list) | ("done", ChatResult)."""
        body: dict[str, Any] = {"model": model, "messages": messages, "stream": True}
        if tools:
            body["tools"] = tools
        if options:
            body["options"] = options
        if keep_alive is not None:
            body["keep_alive"] = keep_alive
        if think is not None:
            body["think"] = think
        result = ChatResult(model=model)
        started = time.perf_counter()
        try:
            async with self._client.stream("POST", "/api/chat", json=body) as resp:
                if resp.status_code >= 400:
                    await resp.aread()
                    raise OllamaError(_error_text(resp))
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    if chunk.get("error"):
                        raise OllamaError(str(chunk["error"]))
                    msg = chunk.get("message") or {}
                    if msg.get("thinking"):
                        result.thinking += msg["thinking"]
                        yield "thinking", msg["thinking"]
                    if msg.get("content"):
                        if result.ttft_ms is None:
                            result.ttft_ms = round((time.perf_counter() - started) * 1000, 1)
                        result.content += msg["content"]
                        yield "delta", msg["content"]
                    if msg.get("tool_calls"):
                        result.tool_calls.extend(msg["tool_calls"])
                        yield "tool_calls", msg["tool_calls"]
                    if chunk.get("done"):
                        apply_final_metrics(result, chunk)
        except httpx.HTTPError as exc:
            raise OllamaUnavailable(f"Ollama is not reachable at {self.base_url}: {exc.__class__.__name__}") from exc
        yield "done", result

    async def chat(self, model: str, messages: list[dict[str, Any]], **kwargs: Any) -> ChatResult:
        result = ChatResult(model=model)
        async for kind, value in self.chat_stream(model, messages, **kwargs):
            if kind == "done":
                result = value
        return result


def _error_text(resp: httpx.Response) -> str:
    try:
        data = resp.json()
        msg = data.get("error") or resp.text
    except ValueError:
        msg = resp.text
    return f"Ollama error {resp.status_code}: {str(msg)[:400]}"
