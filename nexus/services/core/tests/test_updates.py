"""In-app updates against real temporary git repositories."""

import subprocess
import time
from pathlib import Path

import pytest

from conftest import arun


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
                          env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                               "GIT_COMMITTER_EMAIL": "t@t", "PATH": "/usr/bin:/bin:/usr/local/bin", "HOME": str(cwd)}).stdout.strip()


@pytest.fixture
def repos(tmp_path):
    """origin (bare) ← upstream clone (where new commits are made) and local clone (what NEXUS runs from)."""
    origin = tmp_path / "origin.git"
    git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    up = tmp_path / "up"
    git(tmp_path, "clone", "-q", str(origin), str(up))
    (up / "nexus" / "scripts").mkdir(parents=True)
    (up / "nexus" / "README.md").write_text("v1")
    (up / "nexus" / "scripts" / "update.sh").write_text("#!/bin/bash\ngit pull -q --ff-only\necho pulled\necho NEXUS_UPDATE_DONE\n")
    (up / "other.txt").write_text("not nexus")
    git(up, "add", "-A")
    git(up, "commit", "-qm", "initial")
    git(up, "push", "-q", "origin", "HEAD:main")
    local = tmp_path / "local"
    git(tmp_path, "clone", "-q", "-b", "main", str(origin), str(local))
    return {"up": up, "local": local, "nexus": local / "nexus"}


def _push_change(up: Path, path: str, text: str, msg: str):
    p = up / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    git(up, "add", "-A")
    git(up, "commit", "-qm", msg)
    git(up, "push", "-q", "origin", "HEAD:main")


def test_up_to_date_then_update_available(client, st, repos):
    st.updates.nexus_root = repos["nexus"]
    s = arun(client, st.updates.check, True)
    assert s["supported"] and s["available"] is False and s["behind"] == 0
    _push_change(repos["up"], "other.txt", "changed", "unrelated change outside nexus")
    assert arun(client, st.updates.check, True)["available"] is False  # only NEXUS changes count
    _push_change(repos["up"], "nexus/README.md", "v2", "Make the glass clearer")
    s = client.get("/api/system/updates", params={"refresh": True}).json()
    assert s["available"] is True and s["behind"] == 1
    assert s["commits"][0]["subject"] == "Make the glass clearer"
    assert client.get("/api/bootstrap").json()["update"]["available"] is True
    assert any(n["title"] == "NEXUS update available" for n in client.get("/api/notifications").json())


def test_apply_refuses_local_changes(client, st, repos):
    st.updates.nexus_root = repos["nexus"]
    _push_change(repos["up"], "nexus/README.md", "v2", "update")
    (repos["nexus"] / "README.md").write_text("my local edit")
    arun(client, st.updates.check, True)
    r = client.post("/api/system/updates/apply")
    assert r.status_code == 400 and "changed locally" in r.json()["detail"]


def test_apply_runs_updater_and_reports_done(client, st, repos):
    st.updates.nexus_root = repos["nexus"]
    assert client.post("/api/system/updates/apply").status_code == 400  # nothing to update yet
    _push_change(repos["up"], "nexus/README.md", "v2", "update")
    arun(client, st.updates.check, True)
    r = client.post("/api/system/updates/apply")
    assert r.status_code == 200 and r.json()["mode"] == "--dev"
    for _ in range(100):
        out = client.get("/api/system/updates/log").json()
        if not out["applying"]:
            break
        time.sleep(0.05)
    assert out["result"] == "done" and "pulled" in out["lines"]
    # The core's own watcher clears the title-bar state and re-checks, without the Updates page open.
    st.updates.applying = True
    st.updates.result = None
    for _ in range(80):
        if not client.get("/api/bootstrap").json()["update"]["applying"]:
            break
        time.sleep(0.1)
    boot = client.get("/api/bootstrap").json()["update"]
    assert boot["applying"] is False and boot["available"] is False


def test_phone_cannot_trigger_update(client):
    client.patch("/api/devices/remote", json={"enabled": True, "hostnames": ["mac.tail1.ts.net"]})
    code = client.post("/api/devices/pair").json()["code"]
    tok = client.post("/api/devices/claim", json={"code": code}).json()["token"]
    r = client.post("/api/system/updates/apply", headers={"Authorization": f"Bearer {tok}", "Host": "mac.tail1.ts.net"})
    assert r.status_code == 403


def test_not_a_git_checkout(client, st, tmp_path):
    st.updates.nexus_root = tmp_path
    s = arun(client, st.updates.check, False)
    assert s["supported"] is False and "git checkout" in s["error"]
