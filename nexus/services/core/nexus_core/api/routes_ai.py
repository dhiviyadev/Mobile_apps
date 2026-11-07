"""Models, conversations/chat, agents, tasks and Hermes endpoints."""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from ..agents.hermes import HermesUnavailable
from ..app_state import AppState
from ..knowledge.extractors import SUPPORTED, ExtractionError, extract
from ..models.benchmark import benchmark_model
from ..models.ollama import OllamaError
from ..models.router import ModelUnavailable, is_embedding_model
from ..permissions.approvals import EmergencyStopActive
from ..settings_store import MODEL_CATEGORIES
from ..util import new_id, now_iso
from .deps import get_state, not_found, sse

router = APIRouter(prefix="/api")


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, EmergencyStopActive):
        return HTTPException(423, str(exc))
    if isinstance(exc, (ModelUnavailable, OllamaError, HermesUnavailable)):
        return HTTPException(503, str(exc))
    if isinstance(exc, KeyError):
        return HTTPException(404, f"Not found: {exc}")
    if isinstance(exc, ValueError):
        return HTTPException(400, str(exc))
    return HTTPException(500, str(exc))


# -- models -------------------------------------------------------------------
@router.get("/models")
async def models(st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        installed = await st.ollama.list_models()
        running = {m["name"]: m for m in await st.ollama.running_models()}
        online = True
    except OllamaError as exc:
        return {"online": False, "error": str(exc), "installed": [], "routing": st.router.routing_table(),
                "categories": MODEL_CATEGORIES, "default": st.prefs.get("models.default")}
    out = []
    for m in installed:
        d = m.get("details") or {}
        r = running.get(m["name"])
        out.append({"name": m["name"], "size": m.get("size"), "modified_at": m.get("modified_at"),
                    "family": d.get("family"), "parameter_size": d.get("parameter_size"), "quantization": d.get("quantization_level"),
                    "embedding": is_embedding_model(m), "loaded": r is not None, "size_vram": r.get("size_vram") if r else None,
                    "expires_at": r.get("expires_at") if r else None, "state": st.router.loading.get(m["name"], "loaded" if r else "idle")})
    return {"online": online, "version": await st.ollama.version(), "installed": out, "routing": st.router.routing_table(),
            "categories": MODEL_CATEGORIES, "default": st.prefs.get("models.default"),
            "single_model_mode": st.prefs.get("models.single_model_mode"), "stats": st.router.inference_stats()}


@router.post("/models/{name:path}/load")
async def load_model(name: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return await st.router.ensure_loaded(name)
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from exc


@router.post("/models/{name:path}/unload")
async def unload_model(name: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        await st.router.unload(name)
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from exc
    return {"unloaded": name}


class RoutingBody(BaseModel):
    default: str | None = None
    assignments: dict[str, str] | None = None


@router.patch("/models/routing")
async def set_routing(body: RoutingBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    names = {m["name"] for m in await st.ollama.list_models()} if (body.default or body.assignments) else set()
    if body.default is not None:
        if body.default and body.default not in names:
            raise HTTPException(400, f"{body.default} is not installed")
        st.prefs.set("models.default", body.default)
    if body.assignments is not None:
        current = st.prefs.get("models.assignments") or {}
        for cat, model in body.assignments.items():
            if cat not in MODEL_CATEGORIES:
                raise HTTPException(400, f"Unknown category {cat}")
            if model and model not in names:
                raise HTTPException(400, f"{model} is not installed")
            current[cat] = model
        st.prefs.set("models.assignments", current)
    return {"routing": st.router.routing_table(), "default": st.prefs.get("models.default")}


class BenchmarkBody(BaseModel):
    model: str
    cold: bool = True
    tool_trials: int = Field(3, ge=0, le=10)


@router.post("/models/benchmark")
async def benchmark(body: BenchmarkBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return await benchmark_model(st.router, st.ollama, body.model, cold=body.cold, tool_trials=body.tool_trials)
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from exc


@router.get("/models/metrics")
def model_metrics(limit: int = 100, st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.db.query("SELECT * FROM metrics ORDER BY id DESC LIMIT ?", (limit,))


@router.get("/cloud")
def cloud_status(st: AppState = Depends(get_state)) -> dict[str, Any]:
    return st.cloud.status()


# -- conversations ------------------------------------------------------------
class ConversationBody(BaseModel):
    title: str | None = None
    agent_id: str | None = None
    model: str | None = None


@router.get("/conversations")
def list_conversations(q: str | None = None, limit: int = 50, st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.conversations.list(limit=limit, query=q)


@router.post("/conversations")
def create_conversation(body: ConversationBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    return st.conversations.create(body.title, body.agent_id, body.model)


@router.get("/conversations/{cid}")
def get_conversation(cid: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    conv = st.conversations.get(cid)
    if not conv:
        raise not_found("Conversation")
    return {**conv, "messages": st.conversations.messages(cid)}


class ConversationPatch(BaseModel):
    title: str | None = None
    model: str | None = None
    agent_id: str | None = None
    archived: bool | None = None


@router.patch("/conversations/{cid}")
def patch_conversation(cid: str, body: ConversationPatch, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return st.conversations.update(cid, **body.model_dump())
    except KeyError:
        raise not_found("Conversation") from None


@router.delete("/conversations/{cid}")
def delete_conversation(cid: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    st.conversations.delete(cid)
    return {"deleted": cid}


class ChatBody(BaseModel):
    content: str = Field(..., min_length=1, max_length=100_000)
    mode: str = "chat"  # chat | agent
    agent_id: str | None = None
    model: str | None = None
    attachments: list[str] = []
    use_knowledge: bool = True
    use_memory: bool = True
    allow_cloud: bool = False


@router.post("/conversations/{cid}/messages")
async def send_message(cid: str, body: ChatBody, st: AppState = Depends(get_state)) -> Any:
    if not st.conversations.get(cid):
        raise not_found("Conversation")
    if body.mode == "agent":
        try:
            st.conversations.add_message(cid, "user", body.content, metadata={"attachments": body.attachments, "agent_id": body.agent_id})
            prompt = body.content
            if body.attachments:
                text, _ = st.conversations.attachment_context(body.attachments)
                prompt = f"{text}\n\n{prompt}"
            task = st.agents.submit(body.agent_id or "chief", prompt, conversation_id=cid)
        except Exception as exc:  # noqa: BLE001
            raise _http(exc) from exc
        return {"mode": "agent", "task": task}
    try:
        st.approvals.ensure_not_halted()
    except EmergencyStopActive as exc:
        raise _http(exc) from exc
    return sse(st.conversations.stream_reply(cid, body.content, model=body.model, attachments=body.attachments,
                                             use_knowledge=body.use_knowledge, use_memory=body.use_memory,
                                             allow_cloud=body.allow_cloud))


class RegenerateBody(BaseModel):
    model: str | None = None
    allow_cloud: bool = False


@router.post("/conversations/{cid}/regenerate")
async def regenerate(cid: str, body: RegenerateBody, st: AppState = Depends(get_state)) -> Any:
    try:
        content = st.conversations.prepare_regenerate(cid)
    except (KeyError, ValueError) as exc:
        raise _http(exc) from exc
    return sse(st.conversations.stream_reply(cid, content, model=body.model, regenerate=True, allow_cloud=body.allow_cloud))


@router.post("/generations/{gen_id}/stop")
def stop_generation(gen_id: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    return {"stopped": st.conversations.stop(gen_id)}


@router.get("/conversations/{cid}/export", response_class=PlainTextResponse)
def export_conversation(cid: str, st: AppState = Depends(get_state)) -> str:
    try:
        return st.conversations.export_markdown(cid)
    except KeyError:
        raise not_found("Conversation") from None


@router.post("/conversations/{cid}/memories/propose")
async def propose_memories(cid: str, st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    msgs = st.conversations.messages(cid)
    if not msgs:
        raise not_found("Conversation")
    transcript = "\n".join(f"{m['role']}: {m['content']}" for m in msgs if m["role"] in ("user", "assistant"))
    try:
        model = await st.router.resolve("classification")
        return await st.memory.propose_from_conversation(st.ollama, model, cid, transcript)
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from exc


@router.post("/attachments")
async def upload_attachment(file: UploadFile = File(...), st: AppState = Depends(get_state)) -> dict[str, Any]:
    data = await file.read()
    if len(data) > 30 * 1024 * 1024:
        raise HTTPException(413, "Attachments are limited to 30 MB")
    aid = new_id("att")
    safe = Path(file.filename or "file").name.replace("/", "_")[:120]
    dest = st.settings.uploads_dir / f"{aid}-{safe}"
    dest.write_bytes(data)
    text = None
    if dest.suffix.lower() in SUPPORTED:
        try:
            text = "\n\n".join((f"[{loc}]\n" if loc else "") + t for loc, t in extract(dest))
        except ExtractionError as exc:
            text = f"(could not extract text: {exc})"
    mime = file.content_type or mimetypes.guess_type(safe)[0]
    st.db.execute("INSERT INTO attachments(id, filename, path, mime, size, text, created_at) VALUES (?,?,?,?,?,?,?)",
                  (aid, safe, str(dest), mime, len(data), text, now_iso()))
    return {"id": aid, "filename": safe, "size": len(data), "mime": mime, "preview": (text or "")[:4000],
            "has_text": bool(text and not text.startswith("(could not"))}


@router.get("/attachments/{aid}")
def get_attachment(aid: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    row = st.db.query_one("SELECT id, filename, mime, size, substr(text, 1, 20000) AS text, created_at FROM attachments WHERE id = ?", (aid,))
    if not row:
        raise not_found("Attachment")
    return row


# -- agents & tasks -----------------------------------------------------------
@router.get("/agents")
def list_agents(st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.agents.list()


@router.get("/agents/{agent_id}")
def get_agent(agent_id: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    agent = st.agents.get(agent_id)
    if not agent:
        raise not_found("Agent")
    return {**agent, "history": st.agents.history(agent_id), "tool_usage": st.agents.tool_usage(agent_id)}


class AgentPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    system_prompt: str | None = None
    model_category: str | None = None
    tools: list[str] | None = None
    hermes_toolsets: list[str] | None = None
    runtime_pref: str | None = None
    enabled: bool | None = None


@router.patch("/agents/{agent_id}")
def patch_agent(agent_id: str, body: AgentPatch, st: AppState = Depends(get_state)) -> dict[str, Any]:
    if body.model_category and body.model_category not in MODEL_CATEGORIES:
        raise HTTPException(400, "Unknown model category")
    if body.runtime_pref and body.runtime_pref not in ("auto", "hermes", "native"):
        raise HTTPException(400, "runtime_pref must be auto, hermes or native")
    try:
        return st.agents.update(agent_id, **body.model_dump())
    except KeyError:
        raise not_found("Agent") from None


class TaskBody(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=50_000)
    runtime: str | None = None
    conversation_id: str | None = None


@router.post("/agents/{agent_id}/tasks")
async def submit_task(agent_id: str, body: TaskBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return st.agents.submit(agent_id, body.prompt, runtime=body.runtime, conversation_id=body.conversation_id)
    except Exception as exc:  # noqa: BLE001
        raise _http(exc) from exc


@router.get("/tools")
def list_tools() -> list[dict[str, Any]]:
    from ..agents.tools import TOOLS

    return [{"name": t.name, "description": t.description, "access": t.access} for t in TOOLS.values()]


@router.get("/tasks")
def list_tasks(status: str | None = None, kind: str | None = None, limit: int = 50, st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.tasks.list(status=status, kind=kind, limit=limit)


@router.get("/tasks/{task_id}")
def get_task(task_id: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    task = st.tasks.get(task_id)
    if not task:
        raise not_found("Task")
    return {**task, "events": st.tasks.events(task_id)}


@router.post("/tasks/{task_id}/cancel")
async def cancel_task(task_id: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    return {"cancelled": await st.tasks.cancel(task_id)}


# -- Hermes ---------------------------------------------------------------------
@router.get("/hermes/status")
async def hermes_status(st: AppState = Depends(get_state)) -> dict[str, Any]:
    return await st.hermes.status()


@router.get("/hermes/skills")
async def hermes_skills(st: AppState = Depends(get_state)) -> Any:
    try:
        return await st.hermes.list_skills()
    except HermesUnavailable as exc:
        raise _http(exc) from exc


@router.get("/hermes/toolsets")
async def hermes_toolsets(st: AppState = Depends(get_state)) -> Any:
    try:
        return await st.hermes.list_toolsets()
    except HermesUnavailable as exc:
        raise _http(exc) from exc


@router.get("/hermes/sessions")
async def hermes_sessions(st: AppState = Depends(get_state)) -> Any:
    try:
        return await st.hermes.list_sessions()
    except HermesUnavailable as exc:
        raise _http(exc) from exc
