"""Automations: definitions, execution engine and a lightweight scheduler.

Triggers:  manual | schedule (cron, local time) | file (new/modified files in an approved folder)
Actions:   agent_task, prompt (plain LLM), write_file, append_file, notify, reindex_folder,
           reindex_all, run_script
Templates: {{date}}, {{time}}, {{trigger.path}}, {{trigger.name}}, {{previous.output}}, {{steps.N.output}},
           and filters like {{previous.output|truncate:120}}

The scheduler is a single asyncio loop (no extra workflow engine): it checks
cron schedules every 20 s and polls watched folders every 15 s by comparing
mtime snapshots (no FSEvents dependency, works without Full Disk Access).
"""

from __future__ import annotations

import asyncio
import fnmatch
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..db.database import dumps, loads
from ..permissions.approvals import EmergencyStopActive
from ..util import new_id, now_iso, truncate
from .cron import Cron, CronError, describe
from .templates import TEMPLATES

if TYPE_CHECKING:
    from ..app_state import AppState

log = logging.getLogger(__name__)

ACTION_TYPES = {"agent_task", "prompt", "write_file", "append_file", "notify", "reindex_folder", "reindex_all", "run_script"}
TRIGGER_TYPES = {"manual", "schedule", "file"}


class AutomationError(Exception):
    pass


def render(template: str, ctx: dict[str, Any]) -> str:
    def repl(m: re.Match[str]) -> str:
        expr = m.group(1).strip()
        name, _, flt = expr.partition("|")
        value: Any = ctx
        for part in name.strip().split("."):
            if isinstance(value, dict):
                value = value.get(part, "")
            elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
                value = value[int(part)]
            else:
                value = ""
        text = "" if value is None else str(value)
        if flt.startswith("truncate:"):
            text = truncate(text, int(flt.split(":", 1)[1] or 100))
        return text

    return re.sub(r"\{\{(.*?)\}\}", repl, template)


class AutomationService:
    def __init__(self, state: "AppState"):
        self.state = state
        self._snapshots: dict[str, dict[str, float]] = {}
        self._running: set[str] = set()

    # -- CRUD -----------------------------------------------------------------
    def _decode(self, row: dict[str, Any] | None) -> dict[str, Any] | None:
        if row:
            for k in ("trigger", "conditions", "actions", "failure_policy"):
                row[k] = loads(row[k], {} if k in ("trigger", "failure_policy") else [])
            row["enabled"] = bool(row["enabled"])
            row["requires_approval"] = bool(row["requires_approval"])
            if row["trigger"].get("type") == "schedule":
                row["schedule_text"] = describe(row["trigger"].get("cron", ""))
        return row

    def list(self) -> list[dict[str, Any]]:
        rows = [self._decode(r) for r in self.state.db.query("SELECT * FROM automations ORDER BY name")]
        last = {r["automation_id"]: r for r in self.state.db.query(
            "SELECT automation_id, status, started_at FROM automation_runs WHERE id IN "
            "(SELECT id FROM automation_runs a WHERE started_at = (SELECT MAX(started_at) FROM automation_runs b WHERE b.automation_id = a.automation_id))")}
        for r in rows:
            assert r is not None
            r["last_run"] = last.get(r["id"])
        return rows  # type: ignore[return-value]

    def get(self, aid: str) -> dict[str, Any] | None:
        return self._decode(self.state.db.query_one("SELECT * FROM automations WHERE id = ?", (aid,)))

    def validate(self, data: dict[str, Any]) -> None:
        trig = data.get("trigger") or {}
        if trig.get("type") not in TRIGGER_TYPES:
            raise AutomationError(f"trigger.type must be one of {sorted(TRIGGER_TYPES)}")
        if trig["type"] == "schedule":
            try:
                Cron(trig.get("cron", ""))
            except CronError as exc:
                raise AutomationError(f"Invalid schedule: {exc}") from exc
        if trig["type"] == "file":
            folder = self.state.permissions.get_folder(trig.get("folder_id") or "")
            if not folder:
                raise AutomationError("File triggers need an approved folder (trigger.folder_id)")
        actions = data.get("actions") or []
        if not actions:
            raise AutomationError("At least one action is required")
        for a in actions:
            if a.get("type") not in ACTION_TYPES:
                raise AutomationError(f"Unknown action type {a.get('type')}")
            if a["type"] == "agent_task" and not self.state.agents.get(a.get("agent_id", "")):
                raise AutomationError(f"Unknown agent {a.get('agent_id')}")

    def _next_run(self, trigger: dict[str, Any]) -> str | None:
        if trigger.get("type") != "schedule":
            return None
        try:
            return Cron(trigger["cron"]).next_after(datetime.now()).astimezone().isoformat()
        except (CronError, KeyError):
            return None

    def create(self, data: dict[str, Any]) -> dict[str, Any]:
        self.validate(data)
        aid = new_id("aut")
        ts = now_iso()
        self.state.db.execute(
            "INSERT INTO automations(id, name, description, trigger, conditions, actions, enabled, requires_approval, failure_policy, template, created_at, updated_at, next_run_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (aid, data["name"], data.get("description", ""), dumps(data["trigger"]), dumps(data.get("conditions") or []),
             dumps(data["actions"]), int(bool(data.get("enabled", False))), int(bool(data.get("requires_approval", True))),
             dumps(data.get("failure_policy") or {"retries": 0, "notify": True}), data.get("template"), ts, ts,
             self._next_run(data["trigger"])),
        )
        self.state.audit.record("user", "automation.create", data["name"], "created", id=aid)
        auto = self.get(aid)
        self.state.bus.publish("automation.updated", auto or {})
        return auto  # type: ignore[return-value]

    def update(self, aid: str, data: dict[str, Any]) -> dict[str, Any]:
        current = self.get(aid)
        if not current:
            raise KeyError(aid)
        merged = {**current, **{k: v for k, v in data.items() if v is not None}}
        self.validate(merged)
        self.state.db.execute(
            "UPDATE automations SET name=?, description=?, trigger=?, conditions=?, actions=?, enabled=?, requires_approval=?, "
            "failure_policy=?, updated_at=?, next_run_at=? WHERE id=?",
            (merged["name"], merged.get("description", ""), dumps(merged["trigger"]), dumps(merged.get("conditions") or []),
             dumps(merged["actions"]), int(bool(merged["enabled"])), int(bool(merged["requires_approval"])),
             dumps(merged.get("failure_policy") or {}), now_iso(), self._next_run(merged["trigger"]), aid),
        )
        if "enabled" in data:
            self.state.audit.record("user", "automation.enable" if data["enabled"] else "automation.disable", merged["name"], "updated")
            self._snapshots.pop(aid, None)
        auto = self.get(aid)
        self.state.bus.publish("automation.updated", auto or {})
        return auto  # type: ignore[return-value]

    def delete(self, aid: str) -> None:
        self.state.db.execute("DELETE FROM automations WHERE id = ?", (aid,))
        self.state.bus.publish("automation.deleted", {"id": aid})

    def runs(self, aid: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        if aid:
            return self.state.db.query("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?", (aid, limit))
        return self.state.db.query(
            "SELECT r.*, a.name AS automation_name FROM automation_runs r JOIN automations a ON a.id = r.automation_id "
            "ORDER BY r.started_at DESC LIMIT ?", (limit,))

    def templates(self) -> list[dict[str, Any]]:
        return TEMPLATES

    def upcoming(self, limit: int = 5) -> list[dict[str, Any]]:
        rows = [a for a in self.list() if a["enabled"] and a.get("next_run_at")]
        rows.sort(key=lambda a: a["next_run_at"])
        return rows[:limit]

    # -- execution --------------------------------------------------------------
    def trigger(self, aid: str, reason: str = "manual", context: dict[str, Any] | None = None) -> dict[str, Any]:
        auto = self.get(aid)
        if not auto:
            raise KeyError(aid)
        self.state.approvals.ensure_not_halted()
        run_id = new_id("run")
        self.state.db.execute(
            "INSERT INTO automation_runs(id, automation_id, trigger_reason, status, started_at) VALUES (?,?,?,?,?)",
            (run_id, aid, reason, "queued", now_iso()),
        )
        self.state.db.execute("UPDATE automations SET last_run_at = ?, next_run_at = ? WHERE id = ?",
                              (now_iso(), self._next_run(auto["trigger"]), aid))
        task = self.state.tasks.create(f"Automation: {auto['name']}", "automation", input=reason, automation_run_id=run_id,
                                       metadata={"automation_id": aid})
        self.state.db.execute("UPDATE automation_runs SET task_id = ? WHERE id = ?", (task["id"], run_id))

        async def work() -> str:
            return await self._execute(auto, run_id, task["id"], reason, context or {})

        # Automation tasks are coordinators; their agent steps take the agent semaphore themselves.
        self.state.tasks.start(task["id"], work, exclusive=False)
        return {"run_id": run_id, "task_id": task["id"]}

    async def _execute(self, auto: dict[str, Any], run_id: str, task_id: str, reason: str, trigger_ctx: dict[str, Any]) -> str:
        st = self.state
        tm = st.tasks
        db = st.db

        def set_run(status: str, **f: Any) -> None:
            cols = ", ".join(f"{k} = ?" for k in f)
            db.execute(f"UPDATE automation_runs SET status = ?{', ' + cols if cols else ''} WHERE id = ?", (status, *f.values(), run_id))
            st.bus.publish("automation.run", {"run_id": run_id, "automation_id": auto["id"], "status": status})

        tm.add_event(task_id, "automation.triggered", f"Triggered ({reason})", data={"automation_id": auto["id"], **trigger_ctx})
        for cond in auto["conditions"]:
            if not self._condition_ok(cond, trigger_ctx):
                tm.add_event(task_id, "automation.skipped", f"Condition not met: {cond.get('type')}", data=cond)
                set_run("skipped", finished_at=now_iso())
                return "Skipped: conditions not met"

        if auto["requires_approval"]:
            tm.update(task_id, status="waiting_approval")
            set_run("waiting_approval")
            ok = await st.approvals.request(
                "automation.run", f"Run automation “{auto['name']}”",
                f"Trigger: {reason}. Steps: " + ", ".join(a["type"] for a in auto["actions"]),
                {"automation_id": auto["id"], "trigger": trigger_ctx}, task_id=task_id,
            )
            tm.update(task_id, status="running")
            if not ok:
                set_run("denied", finished_at=now_iso())
                tm.add_event(task_id, "automation.denied", "Run was not approved")
                return "Not approved"

        policy = auto.get("failure_policy") or {}
        retries = int(policy.get("retries", 0))
        attempt = 0
        while True:
            attempt += 1
            set_run("running", attempt=attempt)
            try:
                output = await self._run_actions(auto, run_id, task_id, trigger_ctx)
                set_run("completed", finished_at=now_iso(), output=truncate(output, 8000))
                return output
            except (asyncio.CancelledError, EmergencyStopActive):
                set_run("cancelled", finished_at=now_iso())
                raise
            except Exception as exc:  # noqa: BLE001
                tm.add_event(task_id, "automation.step_failed", f"Attempt {attempt} failed", detail=str(exc))
                if attempt <= retries:
                    delay = min(300, 15 * 2 ** (attempt - 1))
                    tm.add_event(task_id, "automation.retry", f"Retrying in {delay}s")
                    await asyncio.sleep(delay)
                    continue
                set_run("failed", finished_at=now_iso(), error=str(exc))
                if policy.get("notify", True):
                    await st.notifications.notify(f"Automation failed: {auto['name']}", str(exc)[:200], level="error")
                raise

    def _condition_ok(self, cond: dict[str, Any], ctx: dict[str, Any]) -> bool:
        t = cond.get("type")
        name = str(ctx.get("name", "")).lower()
        if t == "name_contains":
            return str(cond.get("value", "")).lower() in name
        if t == "extension_in":
            return any(name.endswith(e.lower()) for e in cond.get("values", []))
        if t == "time_between":
            now = datetime.now().strftime("%H:%M")
            return cond.get("start", "00:00") <= now <= cond.get("end", "23:59")
        if t == "weekday":
            return datetime.now().weekday() < 5
        return True

    async def _run_actions(self, auto: dict[str, Any], run_id: str, task_id: str, trigger_ctx: dict[str, Any]) -> str:
        st = self.state
        tm = st.tasks
        now = datetime.now()
        ctx: dict[str, Any] = {"date": now.strftime("%Y-%m-%d"), "time": now.strftime("%H:%M"), "trigger": trigger_ctx,
                               "previous": {"output": ""}, "steps": []}
        output = ""
        for i, action in enumerate(auto["actions"], 1):
            st.approvals.ensure_not_halted()
            kind = action["type"]
            tm.add_event(task_id, "automation.step", f"Step {i}: {kind.replace('_', ' ')}", data={"step": i, "action": kind})
            if kind == "agent_task":
                sub = await st.agents.run_now(action["agent_id"], render(action["prompt"], ctx), automation_run_id=run_id,
                                              title=f"{auto['name']} · step {i}")
                if sub["status"] != "completed":
                    raise AutomationError(f"Agent step failed: {sub.get('error')}")
                output = sub.get("result") or ""
                tm.add_event(task_id, "automation.step_done", f"Agent step finished", detail=truncate(output, 500), data={"subtask": sub["id"]})
            elif kind == "prompt":
                model = await st.router.resolve(action.get("model_category", "general"))
                res = await st.ollama.chat(model, [{"role": "user", "content": render(action["prompt"], ctx)}], options=st.router.chat_options())
                st.router.record_metric("chat", model, result=res)
                output = res.content
            elif kind in ("write_file", "append_file"):
                rel = render(action["path"], ctx).lstrip("/")
                target = st.settings.workspace_dir / rel
                content = render(action.get("content", "{{previous.output}}"), ctx)
                if kind == "append_file":
                    st.permissions.check(target, "write", actor=f"automation:{auto['id']}")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with open(target, "a", encoding="utf-8") as fh:
                        fh.write(content.rstrip("\n") + "\n")
                    st.audit.record(f"automation:{auto['id']}", "fs.append", str(target), "executed")
                else:
                    await st.files.write_text(str(target), content, actor=f"automation:{auto['id']}", task_id=task_id,
                                              overwrite=target.exists())
                tm.add_event(task_id, "automation.file", f"Wrote {rel}", data={"path": str(target)})
            elif kind == "notify":
                await st.notifications.notify(render(action.get("title", auto["name"]), ctx), render(action.get("body", ""), ctx))
            elif kind == "reindex_folder":
                stats = await st.knowledge.index_folder(action["folder_id"])
                output = f"Indexed: {stats}"
            elif kind == "reindex_all":
                parts = []
                for f in st.permissions.list_folders():
                    if f["index_enabled"]:
                        parts.append(f"{f['label']}: {await st.knowledge.index_folder(f['id'])}")
                output = "\n".join(parts) or "No folders to index"
            elif kind == "run_script":
                res = await st.macos.run_script(action["name"], [render(a, ctx) for a in action.get("args", [])],
                                                actor=f"automation:{auto['id']}", task_id=task_id,
                                                require_approval=not action.get("pre_approved", False))
                output = res["stdout"]
                if res["returncode"] != 0:
                    raise AutomationError(f"Script exited with {res['returncode']}: {res['stderr'][:200]}")
            ctx["previous"] = {"output": output}
            ctx["steps"].append({"output": output})
        return output

    # -- scheduler ----------------------------------------------------------------
    def _seed_snapshot(self, aid: str, root: Path, patterns: list[str]) -> dict[str, float]:
        snap: dict[str, float] = {}
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for name in filenames:
                if name.startswith(".") or (patterns and not any(fnmatch.fnmatch(name.lower(), p.lower()) for p in patterns)):
                    continue
                p = os.path.join(dirpath, name)
                try:
                    snap[p] = os.stat(p).st_mtime
                except OSError:
                    continue
            if len(snap) > 20000:
                break
        return snap

    async def check_file_triggers(self) -> None:
        for auto in self.list():
            trig = auto["trigger"]
            if not auto["enabled"] or trig.get("type") != "file":
                continue
            folder = self.state.permissions.get_folder(trig.get("folder_id") or "")
            if not folder:
                continue
            patterns = trig.get("patterns") or []
            snap = await asyncio.to_thread(self._seed_snapshot, auto["id"], Path(folder["path"]), patterns)
            prev = self._snapshots.get(auto["id"])
            self._snapshots[auto["id"]] = snap
            if prev is None:
                continue  # first observation establishes the baseline; existing files don't fire
            events = set(trig.get("events") or ["created"])
            for path, mtime in snap.items():
                kind = "created" if path not in prev else ("modified" if mtime > prev[path] + 1e-3 else None)
                if kind and kind in events and self.state.permissions.is_allowed(path, "read"):
                    try:
                        self.trigger(auto["id"], reason=f"file {kind}", context={"path": path, "name": os.path.basename(path), "event": kind})
                    except EmergencyStopActive:
                        return

    async def check_schedules(self) -> None:
        now = datetime.now().astimezone()
        for auto in self.list():
            if not auto["enabled"] or auto["trigger"].get("type") != "schedule" or not auto.get("next_run_at"):
                continue
            try:
                due = datetime.fromisoformat(auto["next_run_at"])
            except ValueError:
                continue
            if due <= now:
                try:
                    self.trigger(auto["id"], reason="schedule")
                except EmergencyStopActive:
                    return

    async def run_scheduler(self) -> None:
        tick = 0
        while True:
            await asyncio.sleep(5)
            tick += 1
            if self.state.approvals.halted:
                continue
            try:
                if tick % 4 == 0:
                    await self.check_schedules()
                if tick % 3 == 0:
                    await self.check_file_triggers()
            except Exception:  # noqa: BLE001
                log.exception("scheduler tick failed")
