import os
import stat
from pathlib import Path

import pytest

from nexus_core.permissions.policy import PermissionDenied


def test_health_is_public(client):
    r = client.get("/health", headers={"Authorization": ""})
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_api_requires_token(client):
    assert client.get("/api/bootstrap", headers={"Authorization": ""}).status_code == 401
    assert client.get("/api/bootstrap", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/api/bootstrap").status_code == 200


def test_dns_rebinding_host_rejected(client):
    r = client.get("/api/bootstrap", headers={"Host": "attacker.example:8765"})
    assert r.status_code == 421


def test_token_file_permissions(st):
    mode = stat.S_IMODE(os.stat(st.settings.secrets_dir / "api_token").st_mode)
    assert mode == 0o600


def test_websocket_requires_token(client, st):
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws?token=nope") as ws:
            ws.receive_text()
    with client.websocket_connect(f"/ws?token={st.token}") as ws:
        hello = ws.receive_json()
        assert hello["topic"] == "hello"


def test_unapprovable_folders(st, tmp_path):
    for bad in ["/", "/etc", "/usr/bin", str(Path.home())]:
        with pytest.raises(PermissionDenied):
            st.permissions.add_folder(bad)


def test_path_traversal_and_symlink_escape(st, tmp_path):
    approved = tmp_path / "approved"
    secret = tmp_path / "secret"
    approved.mkdir()
    secret.mkdir()
    (secret / "s.txt").write_text("top secret")
    (approved / "ok.txt").write_text("fine")
    (approved / "link").symlink_to(secret)
    st.permissions.add_folder(str(approved))
    assert st.permissions.check(approved / "ok.txt", "read")
    with pytest.raises(PermissionDenied):
        st.permissions.check(str(approved) + "/../secret/s.txt", "read")
    with pytest.raises(PermissionDenied):
        st.permissions.check(approved / "link" / "s.txt", "read")


def test_read_write_execute_are_separate(st, tmp_path):
    d = tmp_path / "ro"
    d.mkdir()
    st.permissions.add_folder(str(d), can_read=True, can_write=False)
    st.permissions.check(d / "a.txt", "read")
    with pytest.raises(PermissionDenied):
        st.permissions.check(d / "a.txt", "write")
    with pytest.raises(PermissionDenied):
        st.permissions.check(d / "a.txt", "execute")


def test_credential_locations_always_denied(st, tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".ssh").mkdir(parents=True)
    (home / ".ssh" / "id_ed25519").write_text("KEY")
    (home / "proj").mkdir()
    (home / "proj" / ".env").write_text("SECRET=1")
    from nexus_core.permissions.policy import PermissionService

    ps = PermissionService(st.db, st.audit, st.settings.workspace_dir, home=home)
    ps.add_folder(str(home / "proj"))
    with pytest.raises(PermissionDenied):
        ps.check(home / "proj" / ".env", "read")
    with pytest.raises(PermissionDenied):
        ps.add_folder(str(home / ".ssh"))


def test_disallowed_read_via_api_is_403_and_audited(client, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("nope")
    r = client.get("/api/files/read", params={"path": str(outside)})
    assert r.status_code == 403
    audit = client.get("/api/audit").json()
    assert any(a["action"] == "fs.read" and a["decision"] == "denied" for a in audit)


def test_secrets_never_returned(client):
    r = client.get("/api/secrets").json()
    assert all(isinstance(v, bool) for v in r["secrets"].values())
