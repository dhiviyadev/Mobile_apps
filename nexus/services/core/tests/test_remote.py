"""Phone pairing and remote-access security."""

from conftest import read_sse

TS_HOST = "my-mac.tail1234.ts.net"


def _enable(client, hosts=(TS_HOST,)):
    r = client.patch("/api/devices/remote", json={"enabled": True, "hostnames": list(hosts)})
    assert r.status_code == 200, r.text


def _pair(client, name="iPhone"):
    code = client.post("/api/devices/pair").json()["code"]
    r = client.post("/api/devices/claim", json={"code": code, "name": name}, headers={"Authorization": ""})
    assert r.status_code == 200, r.text
    return r.json()


def phone(client, token, host=TS_HOST):
    return {"Authorization": f"Bearer {token}", "Host": host}


def test_remote_off_by_default(client):
    st = client.get("/api/devices/remote").json()
    assert st["enabled"] is False and st["hostnames"] == []
    assert client.post("/api/devices/pair").status_code == 400  # can't pair while off
    # Remote hostname is rejected while remote access is off
    assert client.get("/health", headers={"Host": TS_HOST}).status_code == 421


def test_pairing_flow_and_device_access(client, fake_ollama):
    _enable(client)
    dev = _pair(client)
    assert dev["name"] == "iPhone" and len(dev["token"]) > 30
    h = phone(client, dev["token"])
    me = client.get("/api/me", headers=h).json()
    assert me == {"actor": "device:iPhone", "remote": True}
    # A paired phone can chat (streaming) and read status
    assert client.get("/api/bootstrap", headers=h).status_code == 200
    conv = client.post("/api/conversations", json={}, headers=h).json()
    fake_ollama.script({"content": "Hi from your Mac."})
    events = read_sse(client.post(f"/api/conversations/{conv['id']}/messages", json={"content": "hello"}, headers=h))
    assert events[-1]["type"] == "done"
    # The token is never stored in clear
    rows = client.app_state.db.query("SELECT token_hash FROM devices")
    assert rows and rows[0]["token_hash"] != dev["token"] and len(rows[0]["token_hash"]) == 64


def test_codes_are_single_use_and_validated(client):
    _enable(client)
    code = client.post("/api/devices/pair").json()["code"]
    assert client.post("/api/devices/claim", json={"code": "AAAA-BBBB"}).status_code == 400
    assert client.post("/api/devices/claim", json={"code": code.lower().replace("-", " ")}).status_code == 200
    assert client.post("/api/devices/claim", json={"code": code}).status_code == 400  # reused


def test_claim_rate_limited(client):
    _enable(client)
    for _ in range(10):
        client.post("/api/devices/claim", json={"code": "WRONG-CODE"})
    code = client.post("/api/devices/pair").json()["code"]
    r = client.post("/api/devices/claim", json={"code": code})
    assert r.status_code == 400 and "Too many" in r.json()["detail"]


def test_phone_cannot_change_sensitive_things(client, tmp_path):
    _enable(client)
    h = phone(client, _pair(client)["token"])
    d = tmp_path / "docs"
    d.mkdir()
    denied = [
        ("POST", "/api/folders", {"path": str(d)}),
        ("PATCH", "/api/settings", {"values": {"cloud.enabled": True}}),
        ("POST", "/api/secrets", {"account": "hermes.api_key", "value": "x"}),
        ("POST", "/api/scripts", {"name": "x", "filename": "x.sh"}),
        ("PATCH", "/api/agents/chief", {"tools": ["run_script"]}),
        ("POST", "/api/devices/pair", None),
        ("PATCH", "/api/devices/remote", {"hostnames": ["evil.example.com"]}),
        ("POST", "/api/apps/open", {"name": "Terminal"}),
        ("GET", "/docs", None),
    ]
    for method, path, body in denied:
        r = client.request(method, path, json=body, headers=h)
        assert r.status_code == 403, (method, path, r.status_code)
    assert any(a["action"] == "remote.request" and a["decision"] == "denied" for a in client.get("/api/audit").json())


def test_phone_can_approve_and_emergency_stop(client):
    import asyncio

    from conftest import arun

    _enable(client)
    h = phone(client, _pair(client, "Pixel")["token"])
    st = client.app_state

    async def ask():
        return await st.approvals.request("file.delete", "Delete report.md")

    async def go():
        waiter = asyncio.create_task(ask())
        for _ in range(100):
            if st.approvals.pending():
                break
            await asyncio.sleep(0.01)
        return waiter

    waiter = arun(client, go)
    pending = client.get("/api/approvals", headers=h).json()
    assert client.post(f"/api/approvals/{pending[0]['id']}", json={"approve": False}, headers=h).status_code == 200
    audit = client.get("/api/audit").json()
    assert any(a["actor"] == "device:Pixel" and a["decision"] == "denied" for a in audit)
    assert client.post("/api/system/emergency-stop", headers=h).json()["halted"] is True
    assert any(a["actor"] == "device:Pixel" and a["action"] == "emergency.stop" for a in client.get("/api/audit").json())
    client.post("/api/system/resume")
    del waiter


def test_revocation_and_disable(client):
    _enable(client)
    dev = _pair(client)
    h = phone(client, dev["token"])
    assert client.get("/api/me", headers=h).status_code == 200
    client.patch("/api/devices/remote", json={"enabled": False})
    assert client.get("/api/me", headers={"Authorization": f"Bearer {dev['token']}"}).status_code == 403
    _enable(client)
    client.post(f"/api/devices/{dev['device_id']}/revoke")
    assert client.get("/api/me", headers=h).status_code == 401


def test_unknown_host_rejected_even_when_enabled(client):
    _enable(client)
    h = phone(client, _pair(client)["token"], host="attacker.example.com")
    assert client.get("/api/me", headers=h).status_code == 421


def test_hostname_validation(client):
    r = client.patch("/api/devices/remote", json={"hostnames": ["*.ts.net"]})
    assert r.status_code == 400


def test_device_websocket(client):
    import pytest
    from starlette.websockets import WebSocketDisconnect

    _enable(client)
    tok = _pair(client)["token"]
    with client.websocket_connect(f"/ws?token={tok}", headers={"Host": TS_HOST, "Origin": f"https://{TS_HOST}"}) as ws:
        assert ws.receive_json()["topic"] == "hello"
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws?token={tok}", headers={"Host": TS_HOST, "Origin": "https://evil.example.com"}) as ws:
            ws.receive_text()


def test_same_origin_websocket_for_served_phone_app(client):
    _enable(client)
    tok = _pair(client)["token"]
    with client.websocket_connect(f"/ws?token={tok}", headers={"Host": "127.0.0.1:8765", "Origin": "http://127.0.0.1:8765"}) as ws:
        assert ws.receive_json()["topic"] == "hello"
