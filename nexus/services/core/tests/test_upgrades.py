"""Model manager, vision, web tools, projects, OCR, Apple integrations, push."""

import time

from conftest import read_sse, wait_task


# -- model manager ----------------------------------------------------------------------
def test_catalog_marks_fit_and_installed(client):
    data = client.get("/api/models/catalog").json()
    names = {m["name"]: m for m in data["suggested"]}
    assert names["nomic-embed-text"]["installed"] is True  # fake has nomic-embed-text:latest
    assert names["qwen3:14b"]["installed"] is False
    assert all(m["fit"] in ("fits", "tight", "too_big") for m in data["suggested"])
    from nexus_core.models.catalog import fit

    gb = 1024**3
    assert fit(9.3, 24 * gb) == "fits" and fit(18.0, 24 * gb) == "tight" and fit(22.0, 24 * gb) == "too_big"


def test_pull_reports_progress_and_installs(client, fake_ollama):
    r = client.post("/api/models/pull", json={"model": "qwen3:4b"})
    assert r.status_code == 200
    done = wait_task(client, r.json()["task_id"])
    assert done["status"] == "completed"
    pulls = {p["model"]: p for p in client.get("/api/models/catalog").json()["pulls"]}
    assert pulls["qwen3:4b"]["status"] == "done" and pulls["qwen3:4b"]["percent"] == 100
    assert "qwen3:4b" in [m["name"] for m in client.get("/api/models").json()["installed"]]


def test_pull_failure_and_bad_names(client):
    assert client.post("/api/models/pull", json={"model": "bad name; rm -rf"}).status_code == 400
    r = client.post("/api/models/pull", json={"model": "missing:1b"})
    done = wait_task(client, r.json()["task_id"])
    assert done["status"] == "failed" and "does not exist" in done["error"]


def test_delete_model_clears_routing(client, fake_ollama):
    client.patch("/api/models/routing", json={"default": "qwen3:8b", "assignments": {"coding": "qwen3:8b"}})
    assert client.delete("/api/models/qwen3:8b").status_code == 200
    data = client.get("/api/models").json()
    assert "qwen3:8b" not in [m["name"] for m in data["installed"]]
    assert data["default"] == "" and data["routing"]["coding"] == ""


# -- OCR --------------------------------------------------------------------------------
def _text_image(path, text):
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (1400, 300), "white")
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 64)
    except OSError:
        font = ImageFont.load_default(size=64)
    ImageDraw.Draw(img).text((40, 100), text, fill="black", font=font)
    img.save(path)
    return img


def test_ocr_scanned_pdf_and_image_are_searchable(client, st, tmp_path):
    import shutil

    import pytest

    from conftest import arun

    if not shutil.which("tesseract"):
        pytest.skip("no OCR engine on this machine")
    d = tmp_path / "scans"
    d.mkdir()
    img = _text_image(d / "receipt.png", "Invoice 4471 total 980 EUR")
    img.save(d / "scanned-contract.pdf")  # image-only PDF: no text layer
    f = client.post("/api/folders", json={"path": str(d), "index_now": False}).json()
    stats = arun(client, st.knowledge.index_folder, f["id"])
    assert stats["indexed"] == 2, stats
    res = client.post("/api/knowledge/search", json={"query": "invoice 4471"}).json()["results"]
    assert {r["ext"] for r in res} == {".png", ".pdf"}


def test_ocr_unavailable_is_reported_not_crashed(client, st, tmp_path, monkeypatch):
    from conftest import arun
    from nexus_core.knowledge import ocr

    monkeypatch.setattr(ocr, "enabled", False)
    d = tmp_path / "scans"
    d.mkdir()
    _text_image(d / "a.png", "hello")
    f = client.post("/api/folders", json={"path": str(d), "index_now": False}).json()
    stats = arun(client, st.knowledge.index_folder, f["id"])
    assert stats["failed"] == 1
    assert "OCR is turned off" in client.get("/api/knowledge/documents").json()[0]["error"]


# -- vision -----------------------------------------------------------------------------
def _upload_png(client, tmp_path):
    from PIL import Image

    p = tmp_path / "chart.png"
    Image.new("RGB", (40, 40), "red").save(p)
    with open(p, "rb") as fh:
        return client.post("/api/attachments", files={"file": ("chart.png", fh, "image/png")}).json()


def test_images_go_to_vision_models_only(client, fake_ollama, tmp_path):
    fake_ollama.models.append({"name": "gemma4:26b", "size": 1000, "details": {"families": ["gemma"]}})
    att = _upload_png(client, tmp_path)
    assert att["image"] is True
    assert client.get(f"/api/attachments/{att['id']}/file").headers["content-type"] == "image/png"
    conv = client.post("/api/conversations", json={}).json()
    fake_ollama.script({"content": "A red square."})
    ev = read_sse(client.post(f"/api/conversations/{conv['id']}/messages",
                              json={"content": "What is this?", "attachments": [att["id"]], "model": "gemma4:26b"}))
    assert ev[-1]["type"] == "done" and not any(e["type"] == "warning" for e in ev)
    sent = [r for r in fake_ollama.requests if r["path"] == "/api/chat"][-1]["body"]["messages"][-1]
    assert len(sent["images"]) == 1 and len(sent["images"][0]) > 50

    conv2 = client.post("/api/conversations", json={}).json()
    fake_ollama.script({"content": "I can't see it."})
    ev = read_sse(client.post(f"/api/conversations/{conv2['id']}/messages",
                              json={"content": "What is this?", "attachments": [att["id"]], "model": "qwen3:8b"}))
    assert any(e["type"] == "warning" and "can't see images" in e["text"] for e in ev)
    sent = [r for r in fake_ollama.requests if r["path"] == "/api/chat"][-1]["body"]["messages"][-1]
    assert "images" not in sent


def test_screen_capture_is_mac_only_and_blocked_for_phones(client):
    assert client.post("/api/screen/capture").status_code == 400  # not macOS here
    client.patch("/api/devices/remote", json={"enabled": True, "hostnames": ["mac.tail1.ts.net"]})
    code = client.post("/api/devices/pair").json()["code"]
    tok = client.post("/api/devices/claim", json={"code": code}).json()["token"]
    h = {"Authorization": f"Bearer {tok}", "Host": "mac.tail1.ts.net"}
    assert client.post("/api/screen/capture", headers=h).status_code == 403
    assert client.post("/api/models/pull", json={"model": "x:1b"}, headers=h).status_code == 403
