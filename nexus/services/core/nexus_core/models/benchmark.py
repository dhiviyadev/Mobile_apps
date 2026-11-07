"""Measure a model on *this* machine: load time, TTFT, tokens/s, memory, tool-calling."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import psutil

from ..system.macos_metrics import memory_pressure
from .ollama import OllamaClient
from .router import ModelRouter

PROMPT = (
    "Write a concise, well-structured explanation (about 200 words) of how a local-first "
    "personal assistant should decide when to ask the user for confirmation."
)

TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}},
            "required": ["city"],
        },
    },
}


async def benchmark_model(router: ModelRouter, ollama: OllamaClient, model: str, cold: bool = True,
                          tool_trials: int = 3) -> dict[str, Any]:
    out: dict[str, Any] = {"model": model, "cold_start": cold}
    if cold:
        for m in await ollama.running_models():
            if m["name"] == model:
                await ollama.unload(model)
        await asyncio.sleep(1)
    mem_before = psutil.virtual_memory()
    out["memory_before"] = {"available": mem_before.available, "used_percent": mem_before.percent}
    out["pressure_before"] = memory_pressure()

    t0 = time.perf_counter()
    load = await router.ensure_loaded(model)
    out["load"] = {"load_ms": load.get("load_ms"), "wall_ms": round((time.perf_counter() - t0) * 1000, 1)}

    res = await ollama.chat(model, [{"role": "user", "content": PROMPT}], options=router.chat_options())
    out["generation"] = res.metrics()
    router.record_metric("benchmark", model, result=res, detail={"cold": cold})

    running = {m["name"]: m for m in await ollama.running_models()}
    out["resident_bytes"] = running.get(model, {}).get("size")
    out["resident_vram_bytes"] = running.get(model, {}).get("size_vram")
    mem_after = psutil.virtual_memory()
    out["memory_after"] = {"available": mem_after.available, "used_percent": mem_after.percent}
    out["pressure_after"] = memory_pressure()

    # Tool-calling reliability: does the model emit a well-formed call with the right argument?
    ok = 0
    errors: list[str] = []
    for _ in range(tool_trials):
        try:
            r = await ollama.chat(model, [{"role": "user", "content": "What's the weather in Lisbon right now? Use the tool."}],
                                  tools=[TOOL], options=router.chat_options())
            calls = r.tool_calls
            if calls:
                fn = calls[0].get("function", {})
                args = fn.get("arguments")
                if isinstance(args, str):
                    args = json.loads(args)
                if fn.get("name") == "get_weather" and "lisbon" in str(args.get("city", "")).lower():
                    ok += 1
                    continue
            errors.append("no valid tool call")
        except Exception as exc:  # noqa: BLE001
            errors.append(str(exc)[:200])
    out["tool_calling"] = {"trials": tool_trials, "successes": ok, "rate": round(ok / tool_trials, 2) if tool_trials else None,
                           "errors": errors[:3]}
    return out
