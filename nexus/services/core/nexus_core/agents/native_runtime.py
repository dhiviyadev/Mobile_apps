"""NEXUS native agent loop: Ollama tool-calling with NEXUS-governed tools.

Used when Hermes is unavailable or an agent is pinned to the native runtime.
Every model call, tool call, permission denial and approval is a real task event.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

from ..permissions.approvals import EmergencyStopActive
from ..permissions.policy import PermissionDenied
from .tools import TOOLS, ToolContext, tool_result_text

if TYPE_CHECKING:
    from ..app_state import AppState

log = logging.getLogger(__name__)


async def run_native(state: "AppState", task_id: str, agent: dict[str, Any], prompt: str,
                     history: list[dict[str, Any]] | None = None, model: str | None = None) -> str:
    tm = state.tasks
    model = await state.router.resolve(agent["model_category"], model)
    tm.update(task_id, runtime="native", metadata={"model": model})
    tm.add_event(task_id, "model.selected", f"Using {model}", data={"model": model, "category": agent["model_category"]})

    load = await state.router.ensure_loaded(model)
    if load.get("load_ms"):
        tm.add_event(task_id, "model.loaded", f"Loaded {model}", data={"load_ms": load["load_ms"]})

    tools = [TOOLS[t] for t in agent["tools"] if t in TOOLS]
    system = agent["system_prompt"] + (
        "\n\nYou are running inside NEXUS on the user's Mac. Use the provided tools to inspect approved folders, "
        "documents and memory. Do not guess file contents. Tools that change things may require the user's approval; "
        "if a tool is denied, explain what you were unable to do. Finish with a clear answer for the user."
    )
    mems = state.memory.recall(prompt, limit=5)
    if mems:
        system += "\n\n" + state.memory.context_block(mems)
        tm.add_event(task_id, "memory.recalled", f"Recalled {len(mems)} memories", data={"ids": [m["id"] for m in mems]})

    messages: list[dict[str, Any]] = [{"role": "system", "content": system}, *(history or []), {"role": "user", "content": prompt}]
    ctx = ToolContext(state=state, task_id=task_id, agent_id=agent["id"])
    max_steps = int(state.prefs.get("agents.max_steps") or 8)
    final = ""

    for step in range(1, max_steps + 1):
        state.approvals.ensure_not_halted()
        tm.add_event(task_id, "model.thinking", "Thinking" if step == 1 else f"Thinking (step {step})")
        content = ""
        calls: list[dict[str, Any]] = []
        result = None
        async for kind, value in state.ollama.chat_stream(model, messages, tools=[t.schema() for t in tools] or None,
                                                          options=state.router.chat_options(),
                                                          keep_alive=state.prefs.get("models.keep_alive")):
            if kind == "delta":
                content += value
                tm.stream_delta(task_id, value)
            elif kind == "tool_calls":
                calls.extend(value)
            elif kind == "done":
                result = value
        if result:
            state.router.record_metric("agent", model, result=result)
        messages.append({"role": "assistant", "content": content, **({"tool_calls": calls} if calls else {})})
        if not calls:
            final = content
            break
        for call in calls:
            fn = call.get("function", {})
            name = fn.get("name", "")
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {}
            tool = TOOLS.get(name)
            if tool is None or tool not in tools:
                out = f"Error: tool '{name}' is not available to this agent."
                tm.add_event(task_id, "tool.rejected", f"Unavailable tool {name}", data={"tool": name})
            else:
                tm.add_event(task_id, "tool.started", tool.summary(args), data={"tool": name, "args": _redact_args(args)})
                try:
                    res = await tool.handler(ctx, args)
                    out = tool_result_text(res)
                    tm.add_event(task_id, "tool.completed", f"{tool.summary(args)} — done", detail=out[:600], data={"tool": name})
                except EmergencyStopActive:
                    raise
                except PermissionDenied as exc:
                    out = f"Permission denied: {exc}"
                    tm.add_event(task_id, "tool.denied", f"{name}: {exc}", data={"tool": name, "path": exc.path})
                except (KeyError, TypeError, ValueError) as exc:
                    out = f"Error: invalid arguments for {name}: {exc}"
                    tm.add_event(task_id, "tool.failed", f"{name} failed", detail=str(exc), data={"tool": name})
                except Exception as exc:  # noqa: BLE001
                    log.exception("tool %s failed", name)
                    out = f"Error: {exc}"
                    tm.add_event(task_id, "tool.failed", f"{name} failed", detail=str(exc), data={"tool": name})
            messages.append({"role": "tool", "content": out, "tool_name": name})
    else:
        tm.add_event(task_id, "agent.step_limit", f"Stopped after {max_steps} steps")
        final = content or "I reached the step limit before finishing. Here is what I found so far."
    return final


def _redact_args(args: dict[str, Any]) -> dict[str, Any]:
    return {k: (v[:200] + "…" if isinstance(v, str) and len(v) > 200 else v) for k, v in args.items()}
