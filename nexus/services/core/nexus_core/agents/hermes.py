"""Hermes Agent adapter — uses only Hermes' documented integration surfaces.

Two transports, both documented in hermes-agent's
`website/docs/developer-guide/programmatic-integration.md`:

1. **API server** (preferred) — `hermes gateway` with `API_SERVER_ENABLED=true`:
     POST /v1/runs                 start a run            → {run_id}
     GET  /v1/runs/{id}/events     SSE lifecycle events   (message.delta, tool.started/completed,
                                                           approval.request, run.completed/failed/cancelled)
     POST /v1/runs/{id}/stop       interrupt
     POST /v1/runs/{id}/approval   resolve a pending approval {request_id, choice}
     GET  /v1/capabilities, /health, /v1/skills, /v1/toolsets, /api/sessions
2. **CLI one-shot** — `hermes chat --oneshot --query-file - --format stream-json`
   emits documented JSONL events (system/text/tool_use/tool_result/result).
   Cancellation = SIGINT (Hermes exits 130).

NEXUS never edits ~/.hermes. It reads config.yaml read-only for display and
never reads ~/.hermes/.env (it holds secrets). Hermes stays fully usable on its
own when NEXUS is closed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

from ..config import Settings
from ..security import Keychain

if TYPE_CHECKING:
    from ..app_state import AppState

log = logging.getLogger(__name__)

KEYCHAIN_ACCOUNT = "hermes.api_key"


class HermesUnavailable(Exception):
    pass


class HermesAdapter:
    def __init__(self, settings: Settings, keychain: Keychain):
        self.settings = settings
        self.keychain = keychain
        self._status: dict[str, Any] | None = None
        self._status_at = 0.0
        self._version: str | None = None
        self._version_checked = False
        # Injectable for tests; None = real network transport.
        self.transport: httpx.AsyncBaseTransport | None = None

    def _client(self, timeout: Any = 10) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self.settings.hermes_api_url, timeout=timeout, transport=self.transport)

    # -- discovery -----------------------------------------------------------
    @property
    def api_key(self) -> str | None:
        return self.keychain.get(KEYCHAIN_ACCOUNT)

    def _headers(self) -> dict[str, str]:
        key = self.api_key
        return {"Authorization": f"Bearer {key}"} if key else {}

    async def _cli_version(self) -> str | None:
        if self._version_checked:
            return self._version
        self._version_checked = True
        if not self.settings.hermes_bin:
            return None
        try:
            proc = await asyncio.create_subprocess_exec(
                self.settings.hermes_bin, "--version", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
            self._version = out.decode(errors="replace").strip().splitlines()[0][:120] if out else None
        except (OSError, asyncio.TimeoutError):
            self._version = None
        return self._version

    def read_config_summary(self) -> dict[str, Any]:
        """Non-secret facts from ~/.hermes/config.yaml (read-only)."""
        home = self.settings.hermes_home
        cfg_path = home / "config.yaml"
        out: dict[str, Any] = {"home": str(home), "home_exists": home.is_dir(), "config_exists": cfg_path.is_file(),
                               "env_file_exists": (home / ".env").is_file(), "memories_dir_exists": (home / "memories").is_dir(),
                               "skills_dir_exists": (home / "skills").is_dir()}
        if cfg_path.is_file():
            try:
                import yaml

                data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
                model = data.get("model")
                if isinstance(model, dict):
                    out["model"] = {k: model.get(k) for k in ("provider", "default", "base_url") if k in model}
                elif isinstance(model, str):
                    out["model"] = {"default": model}
                gw = (data.get("gateway") or {}).get("api_server") or {}
                if isinstance(gw, dict):
                    out["api_server_config"] = {k: gw.get(k) for k in ("enabled", "host", "port") if k in gw}
                agent = data.get("agent") or {}
                if isinstance(agent, dict):
                    out["agent"] = {k: agent.get(k) for k in ("max_turns", "disabled_toolsets") if k in agent}
            except Exception as exc:  # noqa: BLE001
                out["config_error"] = f"Could not parse config.yaml: {exc.__class__.__name__}"
        return out

    async def status(self, cached: bool = False) -> dict[str, Any]:
        if cached and self._status and time.time() - self._status_at < 15:
            return self._status
        mode = self.settings.hermes_mode
        st: dict[str, Any] = {"mode": mode, "cli_path": self.settings.hermes_bin, "version": None,
                              "api_url": self.settings.hermes_api_url, "api_reachable": False, "api_authenticated": False,
                              "has_api_key": self.api_key is not None, "capabilities": None, "transport": None}
        if mode == "off":
            st["status"] = "disabled"
            self._status, self._status_at = st, time.time()
            return st
        st["version"] = await self._cli_version()
        st["config"] = self.read_config_summary()
        try:
            async with self._client(3) as c:
                r = await c.get("/health")
                st["api_reachable"] = r.status_code == 200
                if st["api_reachable"] and st["has_api_key"]:
                    cap = await c.get("/v1/capabilities", headers=self._headers())
                    st["api_authenticated"] = cap.status_code == 200
                    if cap.status_code == 200:
                        st["capabilities"] = cap.json().get("features")
        except httpx.HTTPError:
            pass
        if mode in ("auto", "api") and st["api_authenticated"] and (st["capabilities"] or {}).get("run_submission", True):
            st["transport"] = "api"
        elif mode in ("auto", "cli") and st["cli_path"]:
            st["transport"] = "cli"
        st["status"] = "ready" if st["transport"] else ("installed" if st["cli_path"] or st["config"]["home_exists"] else "not_installed")
        self._status, self._status_at = st, time.time()
        return st

    async def list_skills(self) -> list[dict[str, Any]]:
        return await self._api_get("/v1/skills")

    async def list_toolsets(self) -> list[dict[str, Any]]:
        return await self._api_get("/v1/toolsets")

    async def list_sessions(self, limit: int = 20) -> Any:
        return await self._api_get(f"/api/sessions?limit={limit}")

    async def _api_get(self, path: str) -> Any:
        if not self.api_key:
            raise HermesUnavailable("No Hermes API key configured in NEXUS")
        async with self._client(10) as c:
            r = await c.get(path, headers=self._headers())
            if r.status_code != 200:
                raise HermesUnavailable(f"Hermes {path} returned {r.status_code}")
            return r.json()

    # -- execution -----------------------------------------------------------
    async def run(self, state: "AppState", task_id: str, agent: dict[str, Any], prompt: str,
                  session_id: str | None = None) -> str:
        st = await self.status()
        if st["transport"] == "api":
            return await self._run_api(state, task_id, agent, prompt, session_id)
        if st["transport"] == "cli":
            return await self._run_cli(state, task_id, agent, prompt)
        raise HermesUnavailable("Hermes is not reachable (API server not running/authenticated and CLI not found)")

    async def _run_api(self, state: "AppState", task_id: str, agent: dict[str, Any], prompt: str,
                       session_id: str | None) -> str:
        tm = state.tasks
        tm.update(task_id, runtime="hermes-api")
        body: dict[str, Any] = {"input": prompt, "instructions": agent["system_prompt"]}
        if session_id:
            body["session_id"] = session_id
        headers = {**self._headers(), "Idempotency-Key": task_id}
        async with self._client(httpx.Timeout(None, connect=5)) as c:
            r = await c.post("/v1/runs", json=body, headers=headers)
            if r.status_code not in (200, 201, 202):
                raise HermesUnavailable(f"Hermes refused the run ({r.status_code}): {r.text[:300]}")
            run_id = r.json()["run_id"]
            tm.update(task_id, external_ref=run_id)
            tm.add_event(task_id, "hermes.run_created", "Submitted to Hermes", data={"run_id": run_id})

            async def stop() -> None:
                async with self._client(10) as sc:
                    await sc.post(f"/v1/runs/{run_id}/stop", headers=self._headers())

            tm.on_cancel(task_id, stop)
            bridges: list[asyncio.Task[None]] = []
            try:
                return await self._consume_events(state, task_id, run_id, c, bridges)
            finally:
                # A run that ended (or was cancelled) no longer waits for its approvals: expire them.
                for b in bridges:
                    if not b.done():
                        b.cancel()

    async def _consume_events(self, state: "AppState", task_id: str, run_id: str, c: httpx.AsyncClient,
                              bridges: list["asyncio.Task[None]"]) -> str:
        tm = state.tasks
        output = ""
        streamed = ""
        async with c.stream("GET", f"/v1/runs/{run_id}/events", headers=self._headers()) as resp:
            if resp.status_code != 200:
                raise HermesUnavailable(f"Hermes event stream failed ({resp.status_code})")
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                try:
                    ev = json.loads(line[5:].strip())
                except ValueError:
                    continue
                name = ev.get("event", "")
                if name == "message.delta":
                    delta = ev.get("delta") or ""
                    streamed += delta
                    tm.stream_delta(task_id, delta)
                elif name == "message.interim" and not ev.get("already_streamed"):
                    tm.add_event(task_id, "agent.commentary", ev.get("text", "")[:200])
                elif name in ("run.queued", "run.started"):
                    tm.add_event(task_id, f"hermes.{name}", "Hermes is working" if name == "run.started" else "Queued in Hermes")
                elif name == "tool.started":
                    tm.add_event(task_id, "tool.started", f"{ev.get('tool')}: {str(ev.get('preview') or '')[:120]}",
                                 data={"tool": ev.get("tool"), "source": "hermes"})
                elif name in ("tool.completed", "tool.failed"):
                    failed = name == "tool.failed" or bool(ev.get("error"))
                    tm.add_event(task_id, "tool.failed" if failed else "tool.completed",
                                 f"{ev.get('tool')} {'failed' if failed else 'done'}", detail=str(ev.get("preview") or "")[:600],
                                 data={"tool": ev.get("tool"), "duration": ev.get("duration"), "source": "hermes"})
                elif name == "subagent.start":
                    tm.add_event(task_id, "subagent.started", "Delegated to a Hermes subagent", data={"source": "hermes"})
                elif name == "subagent.complete":
                    tm.add_event(task_id, "subagent.completed", f"Subagent {ev.get('status', 'finished')}",
                                 detail=str(ev.get("summary") or "")[:600])
                elif name == "approval.request":
                    bridges.append(asyncio.create_task(self._bridge_approval(state, task_id, run_id, ev)))
                elif name == "run.completed":
                    output = ev.get("output") or streamed
                    usage = ev.get("usage") or {}
                    tm.update(task_id, metadata={"hermes_usage": usage, "hermes_runtime": ev.get("runtime")})
                    break
                elif name in ("run.failed", "run.interrupted"):
                    raise HermesUnavailable(f"Hermes run {name.split('.')[1]}: {ev.get('error') or ev.get('turn_exit_reason') or ''}")
                elif name == "run.cancelled":
                    raise asyncio.CancelledError()
        return output

    async def _bridge_approval(self, state: "AppState", task_id: str, run_id: str, ev: dict[str, Any]) -> None:
        """Surface a Hermes approval request in NEXUS and relay the user's decision back."""
        def set_status(new: str, expect: set[str]) -> None:
            cur = state.tasks.get(task_id)
            if cur and cur["status"] in expect:
                state.tasks.update(task_id, status=new)

        set_status("waiting_approval", {"running"})
        desc = ev.get("description") or ""
        cmd = ev.get("command") or ""
        approved = await state.approvals.request(
            "hermes.approval", f"Hermes requests approval: {desc[:80] or 'tool action'}",
            f"{desc}\n\n{cmd}".strip(), {"run_id": run_id, "choices": ev.get("choices")}, task_id=task_id, source="hermes",
        )
        set_status("running", {"waiting_approval"})
        body: dict[str, Any] = {"choice": "once" if approved else "deny"}
        rid = ev.get("request_id") or ev.get("prompt_id")
        if rid:
            body["request_id"] = rid
        if ev.get("execution_generation") is not None:
            body["execution_generation"] = ev["execution_generation"]
        async with self._client(10) as c:
            r = await c.post(f"/v1/runs/{run_id}/approval", json=body, headers=self._headers())
            state.tasks.add_event(task_id, "approval.relayed", f"{'Approved' if approved else 'Denied'} in Hermes",
                                  data={"status": r.status_code})

    async def _run_cli(self, state: "AppState", task_id: str, agent: dict[str, Any], prompt: str) -> str:
        tm = state.tasks
        tm.update(task_id, runtime="hermes-cli")
        argv = [self.settings.hermes_bin or "hermes", "chat", "--oneshot", "--query-file", "-", "--format", "stream-json",
                "--source", "tool"]
        if agent.get("hermes_toolsets"):
            argv += ["--toolsets", ",".join(agent["hermes_toolsets"])]
        # Never pass --yolo: Hermes' own dangerous-command approvals stay in force.
        full_prompt = f"{agent['system_prompt']}\n\n---\n\n{prompt}"
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            cwd=str(state.settings.workspace_dir), limit=4 * 1024 * 1024,
        )
        assert proc.stdin and proc.stdout
        proc.stdin.write(full_prompt.encode())
        await proc.stdin.drain()
        proc.stdin.close()
        tm.add_event(task_id, "hermes.process_started", "Hermes CLI started", data={"pid": proc.pid})

        async def stop() -> None:
            if proc.returncode is None:
                proc.send_signal(signal.SIGINT)
                try:
                    await asyncio.wait_for(proc.wait(), timeout=10)
                except asyncio.TimeoutError:
                    proc.kill()

        tm.on_cancel(task_id, stop)
        text, result = "", None
        try:
            async for raw in proc.stdout:
                try:
                    ev = json.loads(raw.decode(errors="replace"))
                except ValueError:
                    continue
                t = ev.get("type")
                if t == "system":
                    tm.add_event(task_id, "hermes.session", f"Hermes session on {ev.get('model')}",
                                 data={"session_id": ev.get("session_id"), "model": ev.get("model")})
                elif t == "text":
                    text += ev.get("text", "")
                    tm.stream_delta(task_id, ev.get("text", ""))
                elif t == "tool_use":
                    tm.add_event(task_id, "tool.started", f"{ev.get('name')}", data={"tool": ev.get("name"), "source": "hermes"})
                elif t == "tool_result":
                    tm.add_event(task_id, "tool.failed" if ev.get("is_error") else "tool.completed", f"{ev.get('name')} done",
                                 detail=str(ev.get("output", ""))[:600], data={"tool": ev.get("name"), "duration_ms": ev.get("duration_ms")})
                elif t == "result":
                    result = ev
        except asyncio.CancelledError:
            await stop()
            raise
        await proc.wait()
        if result is None:
            err = (await proc.stderr.read()).decode(errors="replace")[-500:] if proc.stderr else ""
            raise HermesUnavailable(f"Hermes exited with code {proc.returncode} without a result. {err}")
        if result.get("exit_code") == 130:
            raise asyncio.CancelledError()
        if result.get("exit_code") not in (0, None):
            raise HermesUnavailable(f"Hermes run failed: {result.get('error') or 'exit code ' + str(result.get('exit_code'))}")
        tm.update(task_id, metadata={"hermes_usage": result.get("tokens"), "hermes_session_id": result.get("session_id")})
        return result.get("text") or text


def hermes_home_default() -> Path:
    return Path.home() / ".hermes"
