import asyncio

import pytest

from conftest import arun

from nexus_core.permissions.approvals import EmergencyStopActive
from nexus_core.permissions.policy import PermissionDenied


async def _approve_next(st, approve: bool):
    for _ in range(200):
        pending = st.approvals.pending()
        if pending:
            st.approvals.decide(pending[0]["id"], approve)
            return pending[0]
        await asyncio.sleep(0.01)
    raise AssertionError("no approval requested")


def test_new_file_in_workspace_needs_no_approval(client, st):
    async def go():
        res = await st.files.write_text(str(st.settings.workspace_dir / "notes" / "a.md"), "# hi")
        assert (st.settings.workspace_dir / "notes" / "a.md").read_text() == "# hi"
        assert res["backup"] is None
    arun(client, go)


def test_overwrite_requires_approval_and_keeps_backup(client, st):
    target = st.settings.workspace_dir / "b.md"
    target.write_text("original")

    async def go(approve):
        task = asyncio.create_task(st.files.write_text(str(target), "new", overwrite=True))
        await _approve_next(st, approve)
        return await task

    with pytest.raises(PermissionDenied):
        arun(client, go, False)
    assert target.read_text() == "original"
    res = arun(client, go, True)
    assert target.read_text() == "new"
    assert res["backup"] and open(res["backup"]).read() == "original"


def test_overwrite_without_flag_refused(st):
    target = st.settings.workspace_dir / "c.md"
    target.write_text("x")
    with pytest.raises(PermissionDenied):
        asyncio.run(st.files.write_text(str(target), "y"))


def test_unapproved_folder_write_denied(st, tmp_path):
    d = tmp_path / "readonly"
    d.mkdir()
    st.permissions.add_folder(str(d), can_write=False)
    with pytest.raises(PermissionDenied):
        asyncio.run(st.files.write_text(str(d / "x.txt"), "data"))
    assert not (d / "x.txt").exists()


def test_delete_moves_to_trash_after_approval(client, st):
    target = st.settings.workspace_dir / "del.txt"
    target.write_text("bye")

    async def go():
        task = asyncio.create_task(st.files.delete(str(target)))
        await _approve_next(st, True)
        return await task

    res = arun(client, go)
    assert not target.exists()
    assert open(res["moved_to"]).read() == "bye"


def test_emergency_stop_blocks_actions(client, st):
    r = client.post("/api/system/emergency-stop").json()
    assert r["halted"] is True
    with pytest.raises(EmergencyStopActive):
        asyncio.run(st.files.write_text(str(st.settings.workspace_dir / "z.txt"), "z"))
    conv = client.post("/api/conversations", json={}).json()
    assert client.post(f"/api/conversations/{conv['id']}/messages", json={"content": "hi"}).status_code == 423
    assert client.post("/api/agents/chief/tasks", json={"prompt": "x"}).status_code == 423
    client.post("/api/system/resume")
    assert not st.approvals.halted


def test_emergency_stop_denies_pending(client, st):
    async def go():
        waiter = asyncio.create_task(st.approvals.request("x", "Do thing"))
        await asyncio.sleep(0.05)
        await st.emergency_stop()
        return await waiter

    assert arun(client, go) is False
    st.approvals.resume()


def test_scripts_must_be_registered(st):
    with pytest.raises(PermissionDenied):
        asyncio.run(st.macos.run_script("rm-everything"))
    with pytest.raises(PermissionDenied):
        st.macos.register_script("evil", "../../bin/sh")
