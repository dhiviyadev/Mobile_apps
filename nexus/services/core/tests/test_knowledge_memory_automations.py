import asyncio
import json
import time
from datetime import datetime

import docx
import openpyxl
import pytest

from conftest import arun, wait_task
from nexus_core.automations.cron import Cron, CronError
from nexus_core.automations.service import render
from nexus_core.memory.service import looks_sensitive

MINIMAL_PDF = b"""%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 58>>stream
BT /F1 18 Tf 72 700 Td (Invoice total 1234 EUR due) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
trailer<</Size 6/Root 1 0 R>>
startxref
0
%%EOF"""


@pytest.fixture
def corpus(tmp_path):
    d = tmp_path / "corpus"
    (d / "sub").mkdir(parents=True)
    (d / "notes.md").write_text("# Roadmap\nThe Falcon project ships in Q3. Owner: Priya.")
    (d / "data.csv").write_text("region,revenue\nEMEA,120\nAPAC,95\n")
    (d / "config.json").write_text(json.dumps({"service": "falcon", "replicas": 3}))
    doc = docx.Document()
    doc.add_heading("Contract", 1)
    doc.add_paragraph("The termination notice period is ninety days.")
    doc.save(d / "contract.docx")
    wb = openpyxl.Workbook()
    wb.active.title = "Budget"
    wb.active.append(["item", "cost"])
    wb.active.append(["GPU cluster", 42000])
    wb.save(d / "budget.xlsx")
    (d / "sub" / "invoice.pdf").write_bytes(MINIMAL_PDF)
    (d / ".hidden.md").write_text("hidden falcon")
    (d / "node_modules").mkdir()
    (d / "node_modules" / "x.md").write_text("falcon in deps")
    return d


def test_index_all_formats_and_search_with_sources(client, st, corpus):
    f = client.post("/api/folders", json={"path": str(corpus), "project": "Falcon", "index_now": False}).json()
    stats = arun(client, st.knowledge.index_folder, f["id"])
    assert stats["indexed"] == 6, stats
    def top(q):
        res = client.post("/api/knowledge/search", json={"query": q}).json()
        assert res["results"], q
        return res["results"][0]
    assert top("Falcon ships")["title"] == "notes"
    assert top("termination notice")["ext"] == ".docx"
    r = top("GPU cluster")
    assert r["ext"] == ".xlsx" and "Budget" in r["location"]
    assert top("EMEA revenue")["ext"] == ".csv"
    assert top("replicas")["ext"] == ".json"
    pdf = top("invoice total")
    assert pdf["ext"] == ".pdf" and pdf["location"] == "page 1"
    assert "\u0002" in pdf["snippet"]  # highlight markers, not HTML
    assert top("Falcon")["project"] == "Falcon"
    hidden = client.post("/api/knowledge/search", json={"query": "deps"}).json()["results"]
    assert not hidden  # node_modules and dotfiles are skipped
    # Incremental: second pass sees everything unchanged
    again = arun(client, st.knowledge.index_folder, f["id"])
    assert again["unchanged"] == 6 and again["indexed"] == 0
    (corpus / "notes.md").unlink()
    assert arun(client, st.knowledge.index_folder, f["id"])["removed"] == 1
    assert client.get("/api/knowledge/history").json()


def test_semantic_hybrid_search(client, st, corpus):
    f = client.post("/api/folders", json={"path": str(corpus), "index_now": False}).json()
    arun(client, st.knowledge.index_folder, f["id"])
    arun(client, st.knowledge.build_embeddings, st.ollama, "nomic-embed-text:latest")
    assert st.knowledge.embedding_coverage()["embedded"] == st.knowledge.stats()["chunks"]
    res = client.post("/api/knowledge/search", json={"query": "invoice", "mode": "hybrid"}).json()
    assert res["mode"] == "hybrid" and res["results"]


def test_sensitive_memory_detection():
    assert looks_sensitive("my password is hunter2")
    assert looks_sensitive("key sk-abcdefghijklmnopqrstuvwx")
    assert looks_sensitive("card 4111 1111 1111 1111")
    assert not looks_sensitive("I prefer concise answers in British English")


def test_memory_lifecycle_and_review(client, st):
    m = client.post("/api/memories", json={"category": "preference", "content": "Prefers British English spelling"}).json()
    assert m["status"] == "active" and m["source_type"] == "user"
    s = client.post("/api/memories", json={"category": "knowledge", "content": "Bank password is hunter2"}).json()
    assert s["status"] == "proposed" and s["sensitive"] == 1
    with pytest.raises(ValueError):
        st.memory.create("preference", "api_key=abc", source_type="agent")
    p = st.memory.create("project", "Working on the Falcon launch", source_type="conversation", source_ref="cnv_1")
    assert p["status"] == "proposed"
    assert not [r for r in st.memory.recall("Falcon launch") if r["id"] == p["id"]]  # proposals are not used
    client.patch(f"/api/memories/{p['id']}", json={"status": "active"})
    assert [r for r in st.memory.recall("Falcon launch") if r["id"] == p["id"]]
    client.delete(f"/api/memories/{p['id']}")
    assert st.memory.get(p["id"]) is None


def test_memory_proposals_from_conversation(client, st, fake_ollama):
    fake_ollama.script({"content": "Sure!"})
    conv = client.post("/api/conversations", json={}).json()
    client.post(f"/api/conversations/{conv['id']}/messages", json={"content": "I'm building Falcon"})
    fake_ollama.script({"content": json.dumps({"memories": [
        {"category": "project", "content": "Building the Falcon product"},
        {"category": "preference", "content": "password: letmein"},
    ]})})
    created = client.post(f"/api/conversations/{conv['id']}/memories/propose").json()
    assert [c["content"] for c in created] == ["Building the Falcon product"]
    assert created[0]["status"] == "proposed" and created[0]["source_ref"] == conv["id"]


def test_cron():
    assert Cron("30 8 * * 1-5").next_after(datetime(2026, 11, 7, 9, 0)) == datetime(2026, 11, 9, 8, 30)
    assert Cron("*/15 * * * *").next_after(datetime(2026, 1, 1, 0, 7)) == datetime(2026, 1, 1, 0, 15)
    assert Cron("0 0 * * sun").next_after(datetime(2026, 11, 7)) == datetime(2026, 11, 8)
    with pytest.raises(CronError):
        Cron("61 * * * *")


def test_render_templates():
    ctx = {"date": "2026-11-07", "trigger": {"name": "a.pdf"}, "previous": {"output": "x" * 50}}
    assert render("{{date}} {{trigger.name}}", ctx) == "2026-11-07 a.pdf"
    assert len(render("{{previous.output|truncate:10}}", ctx)) == 10


def test_manual_automation_runs_actions(client, st, fake_ollama):
    fake_ollama.script({"content": "Top priority: ship Falcon."})
    a = client.post("/api/automations", json={
        "name": "Brief", "trigger": {"type": "manual"}, "requires_approval": False, "enabled": True,
        "actions": [
            {"type": "agent_task", "agent_id": "chief", "prompt": "Brief me for {{date}}"},
            {"type": "write_file", "path": "briefs/{{date}}.md", "content": "{{previous.output}}"},
            {"type": "notify", "title": "Done", "body": "{{previous.output}}"},
        ]}).json()
    run = client.post(f"/api/automations/{a['id']}/run").json()
    done = wait_task(client, run["task_id"])
    assert done["status"] == "completed", done
    out = st.settings.workspace_dir / "briefs" / f"{datetime.now():%Y-%m-%d}.md"
    assert out.read_text() == "Top priority: ship Falcon."
    runs = client.get(f"/api/automations/{a['id']}").json()["runs"]
    assert runs[0]["status"] == "completed"
    assert any(n["title"] == "Done" for n in client.get("/api/notifications").json())


def test_automation_approval_denied(client, st):
    a = client.post("/api/automations", json={"name": "Needs ok", "trigger": {"type": "manual"}, "requires_approval": True,
                                              "actions": [{"type": "notify", "title": "x"}]}).json()
    run = client.post(f"/api/automations/{a['id']}/run").json()
    for _ in range(100):
        pending = client.get("/api/approvals").json()
        if pending:
            break
        time.sleep(0.05)
    client.post(f"/api/approvals/{pending[0]['id']}", json={"approve": False})
    wait_task(client, run["task_id"])
    assert client.get(f"/api/automations/{a['id']}").json()["runs"][0]["status"] == "denied"


def test_automation_validation(client):
    bad = client.post("/api/automations", json={"name": "x", "trigger": {"type": "schedule", "cron": "bad"}, "actions": [{"type": "notify"}]})
    assert bad.status_code == 400
    bad2 = client.post("/api/automations", json={"name": "x", "trigger": {"type": "manual"}, "actions": [{"type": "shell", "cmd": "rm"}]})
    assert bad2.status_code == 400
    tpl = client.post("/api/automations", json={"template": "morning_briefing"}).json()
    assert tpl["enabled"] is False and tpl["schedule_text"].endswith("08:30")


def test_file_trigger_fires_on_new_file(client, st, tmp_path):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    (inbox / "old.pdf").write_text("x")
    f = client.post("/api/folders", json={"path": str(inbox), "index_now": False}).json()
    a = client.post("/api/automations", json={
        "name": "Watch", "enabled": True, "requires_approval": False,
        "trigger": {"type": "file", "folder_id": f["id"], "events": ["created"], "patterns": ["*.pdf"]},
        "actions": [{"type": "append_file", "path": "log.md", "content": "{{trigger.name}}"}]}).json()

    async def go():
        await st.automations.check_file_triggers()  # baseline
        (inbox / "new-invoice.pdf").write_text("y")
        (inbox / "ignore.txt").write_text("z")
        await st.automations.check_file_triggers()
    arun(client, go)
    runs = client.get(f"/api/automations/{a['id']}").json()["runs"]
    assert len(runs) == 1 and runs[0]["trigger_reason"] == "file created"
    wait_task(client, runs[0]["task_id"])
    assert (st.settings.workspace_dir / "log.md").read_text().strip() == "new-invoice.pdf"


def test_restart_marks_orphaned_tasks(settings, fake_ollama):
    from nexus_core.app_state import AppState

    s1 = AppState(settings)
    t = s1.tasks.create("orphan", "agent")
    s1.tasks.update(t["id"], status="running")
    s1.db.close()
    s2 = AppState(settings)
    row = s2.tasks.get(t["id"])
    assert row["status"] == "failed" and "restarted" in row["error"]
    s2.db.close()
