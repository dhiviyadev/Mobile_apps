"""Optional cloud model adapter. OFF by default.

A cloud request is only made when ALL of these hold:
  1. `cloud.enabled` is true in settings (user toggled it in Settings),
  2. a provider + model are configured and an API key is in the Keychain,
  3. the individual request carries `allow_cloud=True` (per-conversation consent),
  4. if the context includes local documents/attachments, `cloud.allow_documents` is true.

A Claude Pro/Max *subscription* does not include API access; an API key from
the provider's console is required and is billed separately.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..security import Keychain
from ..settings_store import SettingsStore


class CloudNotAllowed(Exception):
    pass


class CloudAdapter:
    def __init__(self, settings: SettingsStore, keychain: Keychain):
        self.settings = settings
        self.keychain = keychain

    def status(self) -> dict[str, Any]:
        provider = self.settings.get("cloud.provider") or ""
        return {
            "enabled": bool(self.settings.get("cloud.enabled")),
            "provider": provider,
            "model": self.settings.get("cloud.model") or "",
            "has_key": bool(provider) and self.keychain.has(f"cloud.{provider}"),
            "allow_documents": bool(self.settings.get("cloud.allow_documents")),
            "keychain_available": self.keychain.available,
        }

    def check(self, allow_cloud: bool, includes_documents: bool) -> tuple[str, str, str]:
        st = self.status()
        if not allow_cloud:
            raise CloudNotAllowed("This conversation has not been approved for cloud processing.")
        if not st["enabled"]:
            raise CloudNotAllowed("Cloud models are disabled in Settings.")
        if not st["provider"] or not st["model"]:
            raise CloudNotAllowed("No cloud provider/model configured.")
        if includes_documents and not st["allow_documents"]:
            raise CloudNotAllowed("Sending local documents to cloud providers is disabled in Settings.")
        key = self.keychain.get(f"cloud.{st['provider']}")
        if not key:
            raise CloudNotAllowed("No API key stored in the Keychain for this provider.")
        return st["provider"], st["model"], key

    async def chat_stream(self, messages: list[dict[str, Any]], *, allow_cloud: bool,
                          includes_documents: bool) -> AsyncIterator[tuple[str, Any]]:
        provider, model, key = self.check(allow_cloud, includes_documents)
        if provider == "anthropic":
            async for item in self._anthropic(model, key, messages):
                yield item
        elif provider == "openai_compatible":
            async for item in self._openai(model, key, messages):
                yield item
        else:
            raise CloudNotAllowed(f"Unknown provider {provider}")

    async def _anthropic(self, model: str, key: str, messages: list[dict[str, Any]]) -> AsyncIterator[tuple[str, Any]]:
        system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
        convo = [{"role": m["role"], "content": m["content"]} for m in messages if m["role"] in ("user", "assistant")]
        body: dict[str, Any] = {"model": model, "max_tokens": 4096, "messages": convo, "stream": True}
        if system:
            body["system"] = system
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
        text = ""
        async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=10)) as client:
            async with client.stream("POST", "https://api.anthropic.com/v1/messages", headers=headers, json=body) as r:
                if r.status_code >= 400:
                    await r.aread()
                    raise RuntimeError(f"Cloud provider error {r.status_code}: {r.text[:300]}")
                async for line in r.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = json.loads(line[5:].strip() or "{}")
                    if data.get("type") == "content_block_delta" and data.get("delta", {}).get("type") == "text_delta":
                        chunk = data["delta"]["text"]
                        text += chunk
                        yield "delta", chunk
                    elif data.get("type") == "error":
                        raise RuntimeError(str(data.get("error")))
        yield "done", {"content": text, "model": model, "provider": "anthropic"}

    async def _openai(self, model: str, key: str, messages: list[dict[str, Any]]) -> AsyncIterator[tuple[str, Any]]:
        base = (self.settings.get("cloud.base_url") or "").rstrip("/")
        if not base:
            raise CloudNotAllowed("cloud.base_url is required for openai_compatible providers.")
        text = ""
        async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=10)) as client:
            async with client.stream("POST", f"{base}/chat/completions", headers={"Authorization": f"Bearer {key}"},
                                     json={"model": model, "messages": messages, "stream": True}) as r:
                if r.status_code >= 400:
                    await r.aread()
                    raise RuntimeError(f"Cloud provider error {r.status_code}: {r.text[:300]}")
                async for line in r.aiter_lines():
                    if not line.startswith("data:") or line.strip() == "data: [DONE]":
                        continue
                    data = json.loads(line[5:].strip())
                    delta = (data.get("choices") or [{}])[0].get("delta", {}).get("content")
                    if delta:
                        text += delta
                        yield "delta", delta
        yield "done", {"content": text, "model": model, "provider": "openai_compatible"}
