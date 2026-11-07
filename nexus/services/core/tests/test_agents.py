import json
import os
import stat
import threading
import time

import httpx

from conftest import arun, wait_task


def _tool_call(_fn, **args):
    return {"function": {"name": _fn, "arguments": args}}


def test_native_agent_tool_loop_with_real_events(client, fake_ollama, tmp_path):
    folder = tmp_path / "REstack"
    folder.mkdir()
    (folder / "proposal-a.md").write_text("Proposal A: budget 10k, deadline March.")
    client.post("/api/folders", json={"path": str(folder), "index_now": False})
    fake_ollama.script(
        {"content": "", "tool_calls": [_tool_call("list_folder", path=str(folder))]},
        {"content": "", "tool_calls": [_tool_call("read_file", path=str(folder / "proposal-a.md"))]},
        {"content": "Proposal A has a 10k budget."},
    )
    task = client.post("/api/agents/analyst/tasks", json={"prompt": "Analyse the proposals"}).json()
    done = wait_task(client, task["id"])
    assert done["status"] == "completed", done
    assert done["result"] == "Proposal A has a 10k budget."
    assert done["runtime"] == "native"
    types = [e["type"] for e in done["events"]]
    assert "runtime.fallback" in types  # Hermes not reachable in tests -> honest fallback event
    assert types.count("tool.started") == 2 and types.count("tool.completed") == 2
    # The tool result actually went back to the model.
    last_chat = [r for r in fake_ollama.requests if r["path"] == "/api/chat"][-1]["body"]["messages"]
    assert any(m["role"] == "tool" and "budget 10k" in m["content"] for m in last_chat)


def test_agent_tool_permission_denied_is_reported(client, fake_ollama, tmp_path):
    secret = tmp_path / "private.txt"
    secret.write_text("salary data")
    fake_ollama.script(
        {"content": "", "tool_calls": [_tool_call("read_file", path=str(secret))]},
        {"content": "I could not access that file."},
    )
    task = client.post("/api/agents/analyst/tasks", json={"prompt": "read it", "runtime": "native"}).json()
    done = wait_task(client, task["id"])
    denied = [e for e in done["events"] if e["type"] == "tool.denied"]
    assert denied and "outside all approved folders" in denied[0]["title"]
    msgs = [r for r in fake_ollama.requests if r["path"] == "/api/chat"][-1]["body"]["messages"]
    assert not any("salary data" in (m.get("content") or "") for m in msgs)


def test_agent_cannot_use_tools_outside_its_profile(client, fake_ollama):
    fake_ollama.script({"content": "", "tool_calls": [_tool_call("run_script", name="x")]}, {"content": "ok"})
    task = client.post("/api/agents/knowledge/tasks", json={"prompt": "run", "runtime": "native"}).json()
    done = wait_task(client, task["id"])
    assert any(e["type"] == "tool.rejected" for e in done["events"])


def test_cancel_running_task(client, fake_ollama, st):
    import asyncio

    async def slow(*a, **k):
        await asyncio.sleep(30)
        return "never"

    t = st.tasks.create("slow", "agent")

    async def start():
        st.tasks.start(t["id"], slow)

    arun(client, start)
    time.sleep(0.1)
    assert client.post(f"/api/tasks/{t['id']}/cancel").json()["cancelled"] is True
    done = wait_task(client, t["id"])
    assert done["status"] == "cancelled"


def test_agent_chat_mode_writes_reply_to_conversation(client, fake_ollama):
    fake_ollama.script({"content": "Here is your plan."})
    conv = client.post("/api/conversations", json={}).json()
    r = client.post(f"/api/conversations/{conv['id']}/messages", json={"content": "Plan my day", "mode": "agent", "agent_id": "chief"}).json()
    wait_task(client, r["task"]["id"])
    msgs = client.get(f"/api/conversations/{conv['id']}").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert msgs[1]["content"] == "Here is your plan." and msgs[1]["task_id"] == r["task"]["id"]


def test_agents_list_has_six_specialists(client):
    ids = {a["id"] for a in client.get("/api/agents").json()}
    assert ids == {"chief", "researcher", "developer", "analyst", "knowledge", "automation"}


# -- Hermes adapter ---------------------------------------------------------------
class FakeHermesAPI:
    """Follows the documented /v1/runs contract (programmatic-integration.md).
    Like real Hermes, the event stream pauses after approval.request until /approval is answered."""

    def __init__(self, events):
        self.events = events
        self.calls = []
        self.approved = None

    async def _stream(self):
        import asyncio

        yield b": open\n\n"
        for i, e in enumerate(self.events):
            yield f"id: {i}\ndata: {json.dumps({**e, 'run_id': 'run_123', 'seq': i})}\n\n".encode()
            if e["event"] == "approval.request":
                while self.approved is None:
                    await asyncio.sleep(0.01)

    async def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append((request.method, request.url.path, request.content))
        p = request.url.path
        if p == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.headers.get("authorization") != "Bearer test-key":
            return httpx.Response(401, json={"error": "unauthorized"})
        if p == "/v1/capabilities":
            return httpx.Response(200, json={"features": {"run_submission": True, "run_events_sse": True, "run_stop": True}})
        if p == "/v1/runs" and request.method == "POST":
            return httpx.Response(202, json={"run_id": "run_123", "status": "started"})
        if p == "/v1/runs/run_123/events":
            return httpx.Response(200, content=self._stream(), headers={"content-type": "text/event-stream"})
        if p.endswith("/approval"):
            self.approved = json.loads(request.content)
            return httpx.Response(200, json={"object": "hermes.run.approval_response"})
        if p.endswith("/stop"):
            return httpx.Response(200, json={"status": "stopping"})
        return httpx.Response(404)


def test_hermes_api_run_maps_documented_events(client, st, monkeypatch):
    monkeypatch.setenv("NEXUS_SECRET_HERMES_API_KEY", "test-key")
    fake = FakeHermesAPI([
        {"event": "run.started"},
        {"event": "tool.started", "tool": "web_search", "preview": "query: llamas"},
        {"event": "tool.completed", "tool": "web_search", "duration": 1.2, "error": False, "preview": "3 results"},
        {"event": "message.delta", "delta": "Llamas are "},
        {"event": "message.delta", "delta": "camelids."},
        {"event": "run.completed", "output": "Llamas are camelids.", "usage": {"total_tokens": 99}},
    ])
    st.hermes.transport = httpx.MockTransport(fake.handler)
    st.hermes._status = None
    status = client.get("/api/hermes/status").json()
    assert status["transport"] == "api" and status["status"] == "ready"
    task = client.post("/api/agents/researcher/tasks", json={"prompt": "What are llamas?"}).json()
    done = wait_task(client, task["id"])
    assert done["status"] == "completed", done
    assert done["result"] == "Llamas are camelids."
    assert done["runtime"] == "hermes-api" and done["external_ref"] == "run_123"
    tools = [e for e in done["events"] if e["type"].startswith("tool.")]
    assert [e["type"] for e in tools] == ["tool.started", "tool.completed"]
    body = json.loads(next(c for c in fake.calls if c[1] == "/v1/runs")[2])
    assert body["input"] == "What are llamas?" and "Researcher" in body["instructions"]


def test_hermes_approval_is_bridged_to_nexus(client, st, monkeypatch):
    monkeypatch.setenv("NEXUS_SECRET_HERMES_API_KEY", "test-key")
    fake = FakeHermesAPI([
        {"event": "approval.request", "request_id": "p1", "command": "rm -rf build", "description": "Delete build dir",
         "choices": ["once", "deny"]},
        {"event": "run.completed", "output": "done"},
    ])
    st.hermes.transport = httpx.MockTransport(fake.handler)
    st.hermes._status = None
    task = client.post("/api/agents/developer/tasks", json={"prompt": "clean", "runtime": "hermes"}).json()
    for _ in range(100):
        pending = client.get("/api/approvals").json()
        if pending:
            break
        time.sleep(0.05)
    assert pending and pending[0]["source"] == "hermes" and "rm -rf build" in pending[0]["detail"]
    client.post(f"/api/approvals/{pending[0]['id']}", json={"approve": False})
    for _ in range(100):
        if any(c[1].endswith("/approval") for c in fake.calls):
            break
        time.sleep(0.05)
    assert fake.approved == {"choice": "deny", "request_id": "p1"}
    done = wait_task(client, task["id"])
    assert done["status"] == "completed" and done["result"] == "done"
    assert any(e["type"] == "approval.relayed" for e in done["events"])


def test_hermes_cli_stream_json(client, st, tmp_path):
    script = tmp_path / "hermes"
    lines = [
        {"type": "system", "subtype": "init", "model": "local", "session_id": "s1", "timestamp": 1},
        {"type": "tool_use", "name": "read_file", "timestamp": 2},
        {"type": "tool_result", "name": "read_file", "output": "ok", "duration_ms": 5, "is_error": False, "timestamp": 3},
        {"type": "text", "text": "Answer", "timestamp": 4},
        {"type": "result", "session_id": "s1", "exit_code": 0, "text": "Answer", "tokens": {"total": 5}, "duration_ms": 9, "timestamp": 5},
    ]
    payload = "\n".join(json.dumps(x) for x in lines)
    script.write_text("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'Hermes Agent v9.9 (fake)'; exit 0; fi\n"
                      f"cat > /dev/null\ncat <<'EOF'\n{payload}\nEOF\n")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    st.settings.hermes_bin = str(script)
    st.hermes._version_checked = False
    st.hermes._status = None
    task = client.post("/api/agents/developer/tasks", json={"prompt": "hi"}).json()
    done = wait_task(client, task["id"])
    assert done["status"] == "completed", done
    assert done["result"] == "Answer" and done["runtime"] == "hermes-cli"
    assert [e["type"] for e in done["events"] if e["type"].startswith("tool.")] == ["tool.started", "tool.completed"]
