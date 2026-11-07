from conftest import arun, read_sse


def test_models_discovered_dynamically(client, fake_ollama):
    data = client.get("/api/models").json()
    names = [m["name"] for m in data["installed"]]
    assert names == ["qwen3:8b", "nomic-embed-text:latest"]
    assert [m["embedding"] for m in data["installed"]] == [False, True]


def test_ollama_offline_handled(client, fake_ollama):
    fake_ollama.online = False
    data = client.get("/api/models").json()
    assert data["online"] is False and "not reachable" in data["error"]
    boot = client.get("/api/bootstrap").json()
    assert boot["ollama"]["online"] is False
    conv = client.post("/api/conversations", json={}).json()
    events = read_sse(client.post(f"/api/conversations/{conv['id']}/messages", json={"content": "hi"}))
    assert events[-1]["type"] == "error" and "not reachable" in events[-1]["error"]


def test_streaming_chat_persists_and_records_metrics(client, fake_ollama):
    fake_ollama.script({"content": "Paris is the capital of France."})
    conv = client.post("/api/conversations", json={}).json()
    r = client.post(f"/api/conversations/{conv['id']}/messages", json={"content": "Capital of France?"})
    events = read_sse(r)
    kinds = [e["type"] for e in events]
    assert kinds[0] == "start" and "model" in kinds and kinds[-1] == "done"
    text = "".join(e["text"] for e in events if e["type"] == "delta")
    assert text == "Paris is the capital of France."
    assert sum(1 for k in kinds if k == "delta") > 1  # actually streamed in chunks
    done = events[-1]
    assert done["metrics"]["tokens_per_s"] == 50.0  # 30 tokens / 0.6 s from Ollama's own counters
    full = client.get(f"/api/conversations/{conv['id']}").json()
    assert [m["role"] for m in full["messages"]] == ["user", "assistant"]
    assert full["title"] == "Capital of France?"
    assert client.get("/api/models").json()["stats"]["avg_tokens_per_s"] == 50.0


def test_single_model_mode_unloads_others(client, fake_ollama, st):
    fake_ollama.models.append({"name": "gpt-oss:20b", "size": 13_000_000_000, "details": {"families": ["gptoss"]}})
    fake_ollama.running = [{"name": "gpt-oss:20b", "size": 13_000_000_000}]
    r = client.post("/api/models/qwen3:8b/load")
    assert r.status_code == 200, r.text
    assert [m["name"] for m in fake_ollama.running] == ["qwen3:8b"]


def test_memory_guard_refuses_oversized_model(client, fake_ollama):
    fake_ollama.models.append({"name": "huge:405b", "size": 10**15, "details": {}})
    r = client.post("/api/models/huge:405b/load")
    assert r.status_code == 503 and "Not enough free memory" in r.json()["detail"]


def test_routing_assignment_validated(client):
    assert client.patch("/api/models/routing", json={"assignments": {"coding": "nope:1b"}}).status_code == 400
    r = client.patch("/api/models/routing", json={"assignments": {"coding": "qwen3:8b"}}).json()
    assert r["routing"]["coding"] == "qwen3:8b"


def test_regenerate_and_export(client, fake_ollama):
    fake_ollama.script({"content": "First."}, {"content": "Second."})
    conv = client.post("/api/conversations", json={}).json()
    read_sse(client.post(f"/api/conversations/{conv['id']}/messages", json={"content": "Say something"}))
    events = read_sse(client.post(f"/api/conversations/{conv['id']}/regenerate", json={}))
    assert "".join(e["text"] for e in events if e["type"] == "delta") == "Second."
    msgs = client.get(f"/api/conversations/{conv['id']}").json()["messages"]
    assert [m["content"] for m in msgs] == ["Say something", "Second."]
    md = client.get(f"/api/conversations/{conv['id']}/export").text
    assert "### You" in md and "Second." in md


def test_knowledge_sources_are_cited_in_chat(client, fake_ollama, tmp_path):
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "pricing.md").write_text("# Pricing\nThe REstack enterprise plan costs 4,200 EUR per month.")
    f = client.post("/api/folders", json={"path": str(folder), "index_now": False}).json()
    import asyncio

    arun(client, client.app_state.knowledge.index_folder, f["id"])
    fake_ollama.script({"content": "It costs 4,200 EUR per month [1]."})
    conv = client.post("/api/conversations", json={}).json()
    events = read_sse(client.post(f"/api/conversations/{conv['id']}/messages", json={"content": "How much is the enterprise plan?"}))
    src = next(e for e in events if e["type"] == "sources")
    assert src["sources"][0]["title"] == "pricing"
    chat_req = [r for r in fake_ollama.requests if r["path"] == "/api/chat"][-1]
    assert "4,200 EUR" in chat_req["body"]["messages"][0]["content"]
    assert events[-1]["message"]["metadata"]["sources"][0]["path"].endswith("pricing.md")


def test_cloud_disabled_by_default(st):
    import pytest

    from nexus_core.models.cloud import CloudNotAllowed

    with pytest.raises(CloudNotAllowed):
        st.cloud.check(allow_cloud=True, includes_documents=False)
    with pytest.raises(CloudNotAllowed):
        st.cloud.check(allow_cloud=False, includes_documents=False)
