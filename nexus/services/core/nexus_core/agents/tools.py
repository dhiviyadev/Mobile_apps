"""Tools for the native NEXUS agent runtime.

Every tool declares an access class and routes through the permission,
approval and audit services. There is no general shell tool.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal

from ..integrations.apple import AppleUnavailable
from ..integrations.web import WebBlocked, WebDisabled
from ..markets.service import MarketError
from ..util import truncate

if TYPE_CHECKING:
    from ..app_state import AppState

AccessClass = Literal["read", "write", "execute", "memory", "network", "none"]


@dataclass
class ToolContext:
    state: "AppState"
    task_id: str
    agent_id: str
    project_id: str | None = None
    project_scope: str | None = None  # project name to limit knowledge search to, when it has documents


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    access: AccessClass
    handler: Callable[[ToolContext, dict[str, Any]], Awaitable[Any]]
    summary: Callable[[dict[str, Any]], str]

    def schema(self) -> dict[str, Any]:
        return {"type": "function", "function": {"name": self.name, "description": self.description, "parameters": self.parameters}}


def _obj(props: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required}


async def _current_time(ctx: ToolContext, args: dict[str, Any]) -> Any:
    now = datetime.now().astimezone()
    return {"local_time": now.isoformat(timespec="minutes"), "weekday": now.strftime("%A")}


async def _list_folder(ctx: ToolContext, args: dict[str, Any]) -> Any:
    path = args.get("path") or ""
    if not path:
        return {"approved_folders": [{"label": g.label, "path": str(g.path), "read": g.can_read, "write": g.can_write}
                                     for g in ctx.state.permissions.grants()]}
    return {"entries": ctx.state.files.list_dir(path, actor=f"agent:{ctx.agent_id}")[:200]}


async def _read_file(ctx: ToolContext, args: dict[str, Any]) -> Any:
    return ctx.state.files.read_text(args["path"], actor=f"agent:{ctx.agent_id}", max_chars=int(args.get("max_chars") or 20000))


async def _search_files(ctx: ToolContext, args: dict[str, Any]) -> Any:
    return {"matches": ctx.state.files.search_names(args["pattern"], args.get("root"), limit=50, actor=f"agent:{ctx.agent_id}")}


async def _search_knowledge(ctx: ToolContext, args: dict[str, Any]) -> Any:
    st = ctx.state
    res = await st.knowledge.search(args["query"], limit=int(args.get("limit") or 6), project=args.get("project") or ctx.project_scope,
                                    ollama=st.ollama, router=st.router)
    return {"mode": res["mode"], "results": [
        {"title": r["title"], "path": r["path"], "location": r["location"],
         "snippet": r["snippet"].replace("\u0002", "").replace("\u0003", "")} for r in res["results"]]}


async def _write_file(ctx: ToolContext, args: dict[str, Any]) -> Any:
    st = ctx.state
    path = args["path"]
    if not path.startswith("/"):
        path = str(st.settings.workspace_dir / path)
    return await st.files.write_text(path, args["content"], actor=f"agent:{ctx.agent_id}", task_id=ctx.task_id,
                                     overwrite=bool(args.get("overwrite")))


async def _recall_memory(ctx: ToolContext, args: dict[str, Any]) -> Any:
    return {"memories": [{"category": m["category"], "content": m["content"]}
                         for m in ctx.state.memory.recall(args["query"], limit=8, project_id=ctx.project_id)]}


async def _propose_memory(ctx: ToolContext, args: dict[str, Any]) -> Any:
    mem = ctx.state.memory.create(args["category"], args["content"], source_type="agent", source_ref=ctx.task_id, status="proposed",
                                  project_id=ctx.project_id)
    return {"proposed": True, "id": mem["id"], "note": "Saved as a proposal; the user must approve it before it is used."}


async def _list_tasks(ctx: ToolContext, args: dict[str, Any]) -> Any:
    return {"tasks": [{"title": t["title"], "status": t["status"], "created_at": t["created_at"]}
                      for t in ctx.state.tasks.list(limit=int(args.get("limit") or 10))]}


async def _send_notification(ctx: ToolContext, args: dict[str, Any]) -> Any:
    await ctx.state.notifications.notify(args["title"], args.get("body", ""))
    return {"sent": True}


async def _run_script(ctx: ToolContext, args: dict[str, Any]) -> Any:
    return await ctx.state.macos.run_script(args["name"], args.get("args") or [], actor=f"agent:{ctx.agent_id}", task_id=ctx.task_id)


async def _open_application(ctx: ToolContext, args: dict[str, Any]) -> Any:
    return await ctx.state.macos.open_app(args["name"], actor=f"agent:{ctx.agent_id}", task_id=ctx.task_id)


async def _web_search(ctx: ToolContext, args: dict[str, Any]) -> Any:
    try:
        return await ctx.state.web.search(args["query"], limit=int(args.get("limit") or 6), actor=f"agent:{ctx.agent_id}")
    except (WebDisabled, WebBlocked) as exc:
        return {"error": str(exc)}


async def _fetch_url(ctx: ToolContext, args: dict[str, Any]) -> Any:
    try:
        return await ctx.state.web.fetch(args["url"], max_chars=int(args.get("max_chars") or 20000), actor=f"agent:{ctx.agent_id}")
    except (WebDisabled, WebBlocked) as exc:
        return {"error": str(exc)}


async def _calendar_events(ctx: ToolContext, args: dict[str, Any]) -> Any:
    try:
        return await ctx.state.apple.events(int(args.get("days") or 1), actor=f"agent:{ctx.agent_id}")
    except AppleUnavailable as exc:
        return {"error": str(exc)}


async def _list_reminders(ctx: ToolContext, args: dict[str, Any]) -> Any:
    try:
        return await ctx.state.apple.reminders(actor=f"agent:{ctx.agent_id}")
    except AppleUnavailable as exc:
        return {"error": str(exc)}


async def _create_reminder(ctx: ToolContext, args: dict[str, Any]) -> Any:
    try:
        return await ctx.state.apple.create_reminder(args["title"], args.get("notes") or "", args.get("due"),
                                                     actor=f"agent:{ctx.agent_id}", task_id=ctx.task_id)
    except AppleUnavailable as exc:
        return {"error": str(exc)}


async def _draft_email(ctx: ToolContext, args: dict[str, Any]) -> Any:
    try:
        return await ctx.state.apple.draft_email(args.get("to") or "", args.get("subject") or "", args.get("body") or "",
                                                 actor=f"agent:{ctx.agent_id}", task_id=ctx.task_id)
    except AppleUnavailable as exc:
        return {"error": str(exc)}


async def _market_data(ctx: ToolContext, args: dict[str, Any]) -> Any:
    try:
        return await ctx.state.markets.summary(args["symbol"], args.get("range") or "6mo")
    except MarketError as exc:
        return {"error": str(exc)}


TOOLS: dict[str, Tool] = {
    t.name: t
    for t in [
        Tool("current_time", "Get the user's current local date and time.", _obj({}, []), "none", _current_time,
             lambda a: "Checking the time"),
        Tool("list_folder", "List files in an approved folder. Call with no path to list the approved folders.",
             _obj({"path": {"type": "string", "description": "Absolute folder path"}}, []), "read", _list_folder,
             lambda a: f"Scanning {a.get('path') or 'approved folders'}"),
        Tool("read_file", "Read the text of a file (txt, md, pdf, docx, xlsx, csv, json, code) in an approved folder.",
             _obj({"path": {"type": "string"}, "max_chars": {"type": "integer"}}, ["path"]), "read", _read_file,
             lambda a: f"Reading {str(a.get('path', '')).rsplit('/', 1)[-1]}"),
        Tool("search_files", "Find files by name (glob or substring) across approved folders.",
             _obj({"pattern": {"type": "string"}, "root": {"type": "string"}}, ["pattern"]), "read", _search_files,
             lambda a: f"Searching filenames for “{a.get('pattern')}”"),
        Tool("search_knowledge", "Search the user's indexed documents. Returns snippets with source paths.",
             _obj({"query": {"type": "string"}, "project": {"type": "string"}, "limit": {"type": "integer"}}, ["query"]),
             "read", _search_knowledge, lambda a: f"Searching knowledge for “{a.get('query')}”"),
        Tool("write_file", "Create a file. Relative paths go to the NEXUS workspace. Overwriting requires user approval.",
             _obj({"path": {"type": "string"}, "content": {"type": "string"}, "overwrite": {"type": "boolean"}}, ["path", "content"]),
             "write", _write_file, lambda a: f"Writing {str(a.get('path', '')).rsplit('/', 1)[-1]}"),
        Tool("recall_memory", "Look up reviewed long-term memories about the user.",
             _obj({"query": {"type": "string"}}, ["query"]), "memory", _recall_memory, lambda a: "Recalling memory"),
        Tool("propose_memory", "Propose a durable fact to remember (user must approve). Never store secrets.",
             _obj({"category": {"type": "string", "enum": ["preference", "project", "task", "decision"]},
                   "content": {"type": "string"}}, ["category", "content"]), "memory", _propose_memory,
             lambda a: "Proposing a memory"),
        Tool("list_tasks", "List recent NEXUS tasks and their status.", _obj({"limit": {"type": "integer"}}, []), "none",
             _list_tasks, lambda a: "Reviewing tasks"),
        Tool("send_notification", "Show a notification to the user.",
             _obj({"title": {"type": "string"}, "body": {"type": "string"}}, ["title"]), "none", _send_notification,
             lambda a: "Sending notification"),
        Tool("run_script", "Run an approved script by name (requires user approval).",
             _obj({"name": {"type": "string"}, "args": {"type": "array", "items": {"type": "string"}}}, ["name"]),
             "execute", _run_script, lambda a: f"Requesting to run script {a.get('name')}"),
        Tool("open_application", "Open a macOS application by name (requires user approval).",
             _obj({"name": {"type": "string"}}, ["name"]), "execute", _open_application,
             lambda a: f"Requesting to open {a.get('name')}"),
        Tool("web_search", "Search the public web. Returns titles, links and short snippets. Only works when the user has turned web access on.",
             _obj({"query": {"type": "string"}, "limit": {"type": "integer"}}, ["query"]), "network", _web_search,
             lambda a: f"Searching the web for “{a.get('query')}”"),
        Tool("fetch_url", "Read the text of a public web page (http/https). Only works when the user has turned web access on.",
             _obj({"url": {"type": "string"}, "max_chars": {"type": "integer"}}, ["url"]), "network", _fetch_url,
             lambda a: f"Reading {str(a.get('url', ''))[:80]}"),
        Tool("market_data", "Look up a share, fund, index or crypto price by ticker symbol (e.g. AAPL, BTC-USD): latest price, "
             "change, period high/low and recent closes. Read-only; you cannot place trades. Needs Markets turned on.",
             _obj({"symbol": {"type": "string"}, "range": {"type": "string", "enum": ["1d", "5d", "1mo", "6mo", "1y", "5y"]}}, ["symbol"]),
             "network", _market_data, lambda a: f"Checking the price of {a.get('symbol')}"),
        Tool("calendar_events", "List the user's calendar events for today and the next days (1-14). Needs Calendar access turned on.",
             _obj({"days": {"type": "integer", "description": "How many days from today, default 1"}}, []), "read", _calendar_events,
             lambda a: "Checking the calendar"),
        Tool("list_reminders", "List the user's open reminders with due dates. Needs Reminders access turned on.",
             _obj({}, []), "read", _list_reminders, lambda a: "Checking reminders"),
        Tool("create_reminder", "Add a reminder to the Reminders app (requires user approval). due is local time like 2026-03-01T09:00.",
             _obj({"title": {"type": "string"}, "notes": {"type": "string"}, "due": {"type": "string"}}, ["title"]), "write",
             _create_reminder, lambda a: f"Requesting to add reminder “{a.get('title')}”"),
        Tool("draft_email", "Open a draft in the Mail app for the user to review and send (requires user approval). Never sends.",
             _obj({"to": {"type": "string", "description": "One email address, or empty"}, "subject": {"type": "string"},
                   "body": {"type": "string"}}, ["subject", "body"]), "write", _draft_email,
             lambda a: f"Requesting to draft email “{a.get('subject')}”"),
    ]
}


def tool_result_text(result: Any, limit: int = 12000) -> str:
    text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
    return truncate(text, limit)
