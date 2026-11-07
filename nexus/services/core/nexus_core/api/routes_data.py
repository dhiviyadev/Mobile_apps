"""Knowledge, folders/permissions, memory, automations, voice and macOS integration endpoints."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..app_state import AppState
from ..automations.service import AutomationError
from ..automations.templates import TEMPLATES
from ..permissions.approvals import EmergencyStopActive
from ..permissions.policy import PermissionDenied
from ..voice.service import VoiceUnavailable
from .deps import get_state, not_found

router = APIRouter(prefix="/api")


def _denied(exc: PermissionDenied) -> HTTPException:
    return HTTPException(403, {"message": str(exc), "path": exc.path})


# -- folders (permissions) ----------------------------------------------------
class FolderBody(BaseModel):
    path: str
    label: str | None = None
    project: str | None = None
    can_read: bool = True
    can_write: bool = False
    can_execute: bool = False
    index_enabled: bool = True
    index_now: bool = True


@router.get("/folders")
def list_folders(st: AppState = Depends(get_state)) -> dict[str, Any]:
    return {"workspace": str(st.settings.workspace_dir), "folders": st.permissions.list_folders()}


@router.post("/folders")
async def add_folder(body: FolderBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        folder = st.permissions.add_folder(body.path, body.label, body.project, body.can_read, body.can_write,
                                           body.can_execute, body.index_enabled)
    except PermissionDenied as exc:
        raise _denied(exc) from exc
    if body.index_now and body.index_enabled and body.can_read:
        asyncio.create_task(st.knowledge.index_folder(folder["id"]))
    return folder


class FolderPatch(BaseModel):
    label: str | None = None
    project: str | None = None
    can_read: bool | None = None
    can_write: bool | None = None
    can_execute: bool | None = None
    index_enabled: bool | None = None


@router.patch("/folders/{folder_id}")
def patch_folder(folder_id: str, body: FolderPatch, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return st.permissions.update_folder(folder_id, **body.model_dump())
    except KeyError:
        raise not_found("Folder") from None


@router.delete("/folders/{folder_id}")
def remove_folder(folder_id: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        st.permissions.remove_folder(folder_id)
    except KeyError:
        raise not_found("Folder") from None
    st.knowledge.vectors.invalidate()
    return {"removed": folder_id}


@router.post("/folders/{folder_id}/index")
async def index_folder(folder_id: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    if not st.permissions.get_folder(folder_id):
        raise not_found("Folder")
    if folder_id in st.knowledge.indexing:
        raise HTTPException(409, "Already indexing")
    asyncio.create_task(st.knowledge.index_folder(folder_id))
    return {"started": True}


@router.post("/permissions/check")
def check_path(body: dict[str, str], st: AppState = Depends(get_state)) -> dict[str, Any]:
    path = body.get("path", "")
    return {a: st.permissions.is_allowed(path, a) for a in ("read", "write", "execute")}  # type: ignore[arg-type]


# -- knowledge ------------------------------------------------------------------
class SearchBody(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)
    mode: str = "auto"
    limit: int = Field(10, ge=1, le=50)
    project: str | None = None


@router.post("/knowledge/search")
async def search(body: SearchBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    return await st.knowledge.search(body.query, limit=body.limit, mode=body.mode, project=body.project,
                                     ollama=st.ollama, router=st.router)


@router.get("/knowledge/stats")
def knowledge_stats(st: AppState = Depends(get_state)) -> dict[str, Any]:
    return st.knowledge.stats()


@router.get("/knowledge/history")
def knowledge_history(st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.knowledge.search_history()


@router.get("/knowledge/documents")
def documents(folder_id: str | None = None, limit: int = 200, offset: int = 0, st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.knowledge.documents(folder_id, limit, offset)


@router.get("/knowledge/documents/{doc_id}")
def document(doc_id: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    doc = st.knowledge.document(doc_id)
    if not doc:
        raise not_found("Document")
    return doc


@router.post("/knowledge/embeddings")
async def build_embeddings(st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        model = await st.router.resolve("embeddings")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, str(exc)) from exc
    task = st.tasks.create(f"Build embeddings ({model})", "index")

    async def work() -> str:
        res = await st.knowledge.build_embeddings(st.ollama, model)
        return f"Embedded {res['embedded']} chunks with {model}"

    st.tasks.start(task["id"], work, exclusive=False)
    return {"task": task, "model": model}


# -- memory -----------------------------------------------------------------------
class MemoryBody(BaseModel):
    category: str
    content: str = Field(..., min_length=1, max_length=4000)
    pinned: bool = False


@router.get("/memories")
def list_memories(category: str | None = None, status: str | None = None, st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.memory.list(category=category, status=status)


@router.post("/memories")
def create_memory(body: MemoryBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return st.memory.create(body.category, body.content, source_type="user", pinned=body.pinned)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


class MemoryPatch(BaseModel):
    category: str | None = None
    content: str | None = None
    status: str | None = None
    pinned: bool | None = None
    relevance: float | None = None


@router.patch("/memories/{memory_id}")
def patch_memory(memory_id: str, body: MemoryPatch, st: AppState = Depends(get_state)) -> dict[str, Any]:
    if body.status and body.status not in ("proposed", "active", "archived"):
        raise HTTPException(400, "invalid status")
    try:
        mem = st.memory.update(memory_id, **body.model_dump())
    except KeyError:
        raise not_found("Memory") from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if body.status:
        st.audit.record("user", f"memory.{body.status}", memory_id, "updated")
    return mem


@router.delete("/memories/{memory_id}")
def delete_memory(memory_id: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    st.memory.delete(memory_id)
    st.audit.record("user", "memory.delete", memory_id, "deleted")
    return {"deleted": memory_id}


@router.post("/memories/recall")
def recall(body: dict[str, str], st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.memory.recall(body.get("query", ""), limit=10, mark_used=False)


# -- automations ----------------------------------------------------------------
@router.get("/automations")
def list_automations(st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.automations.list()


@router.get("/automations/templates")
def templates() -> list[dict[str, Any]]:
    return TEMPLATES


@router.get("/automations/runs")
def all_runs(limit: int = 50, st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.automations.runs(limit=limit)


class AutomationBody(BaseModel):
    name: str | None = None
    description: str | None = None
    trigger: dict[str, Any] | None = None
    conditions: list[dict[str, Any]] | None = None
    actions: list[dict[str, Any]] | None = None
    enabled: bool | None = None
    requires_approval: bool | None = None
    failure_policy: dict[str, Any] | None = None
    template: str | None = None


@router.post("/automations")
def create_automation(body: AutomationBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    data = {k: v for k, v in body.model_dump().items() if v is not None}
    if body.template and not body.actions:
        tpl = next((t for t in TEMPLATES if t["template"] == body.template), None)
        if not tpl:
            raise HTTPException(400, "Unknown template")
        data = {**tpl, **data, "enabled": False}
    if not data.get("name"):
        raise HTTPException(400, "name is required")
    try:
        return st.automations.create(data)
    except AutomationError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/automations/{aid}")
def get_automation(aid: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    auto = st.automations.get(aid)
    if not auto:
        raise not_found("Automation")
    return {**auto, "runs": st.automations.runs(aid)}


@router.patch("/automations/{aid}")
def patch_automation(aid: str, body: AutomationBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return st.automations.update(aid, {k: v for k, v in body.model_dump().items() if v is not None})
    except KeyError:
        raise not_found("Automation") from None
    except AutomationError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/automations/{aid}")
def delete_automation(aid: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    st.automations.delete(aid)
    return {"deleted": aid}


@router.post("/automations/{aid}/run")
async def run_automation(aid: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return st.automations.trigger(aid, reason="manual")
    except KeyError:
        raise not_found("Automation") from None
    except EmergencyStopActive as exc:
        raise HTTPException(423, str(exc)) from exc


# -- voice ------------------------------------------------------------------------
@router.get("/voice/status")
def voice_status(st: AppState = Depends(get_state)) -> dict[str, Any]:
    return st.voice.status()


@router.get("/voice/voices")
async def voices(st: AppState = Depends(get_state)) -> list[dict[str, str]]:
    return await st.voice.voices()


@router.post("/voice/transcribe")
async def transcribe(file: UploadFile = File(...), st: AppState = Depends(get_state)) -> dict[str, Any]:
    data = await file.read()
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(413, "Recording too long")
    try:
        return await st.voice.transcribe(data, file.filename or "audio.webm")
    except VoiceUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc


class SpeakBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=8000)
    voice: str | None = None


@router.post("/voice/speak")
async def speak(body: SpeakBody, st: AppState = Depends(get_state)) -> Response:
    try:
        audio, mime = await st.voice.speak(body.text, body.voice)
    except VoiceUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    return Response(content=audio, media_type=mime)


# -- files & macOS (user-initiated) -----------------------------------------------
@router.get("/files/list")
def files_list(path: str, st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    try:
        return st.files.list_dir(path, actor="user")
    except PermissionDenied as exc:
        raise _denied(exc) from exc


@router.get("/files/read")
def files_read(path: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return st.files.read_text(path, actor="user", max_chars=40000)
    except PermissionDenied as exc:
        raise _denied(exc) from exc


@router.get("/files/search")
def files_search(q: str, st: AppState = Depends(get_state)) -> list[dict[str, Any]]:
    return st.files.search_names(q, limit=60, actor="user")


@router.post("/files/open")
async def files_open(body: dict[str, str], st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        if body.get("reveal"):
            return await st.macos.reveal_in_finder(body["path"])
        return await st.macos.open_path(body["path"])
    except PermissionDenied as exc:
        raise _denied(exc) from exc


@router.get("/apps")
def apps(st: AppState = Depends(get_state)) -> list[str]:
    return st.macos.list_apps()


@router.post("/apps/open")
async def open_app(body: dict[str, str], st: AppState = Depends(get_state)) -> dict[str, Any]:
    # The user clicked it themselves: no approval prompt, but still validated and audited.
    try:
        return await st.macos.open_app(body.get("name", ""), actor="user", require_approval=False)
    except (PermissionDenied, EmergencyStopActive) as exc:
        raise HTTPException(403, str(exc)) from exc


@router.get("/shortcuts")
async def shortcuts(st: AppState = Depends(get_state)) -> list[str]:
    return await st.macos.list_shortcuts()


@router.get("/scripts")
def scripts(st: AppState = Depends(get_state)) -> dict[str, Any]:
    return {"dir": str(st.settings.scripts_dir), "scripts": st.macos.list_scripts()}


class ScriptBody(BaseModel):
    name: str
    filename: str
    description: str = ""
    timeout_s: int = 60


@router.post("/scripts")
def register_script(body: ScriptBody, st: AppState = Depends(get_state)) -> dict[str, Any]:
    try:
        return st.macos.register_script(body.name, body.filename, body.description, body.timeout_s)
    except PermissionDenied as exc:
        raise _denied(exc) from exc


@router.delete("/scripts/{script_id}")
def remove_script(script_id: str, st: AppState = Depends(get_state)) -> dict[str, Any]:
    st.macos.remove_script(script_id)
    return {"removed": script_id}
