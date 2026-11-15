"""Local OCR for scanned PDFs and images.

Engines, first available wins:
  * Apple Vision via the `nexus-ocr` Swift helper (macOS; accurate, GPU-accelerated, offline)
  * Tesseract (+ pdftoppm for PDFs) if installed — used on non-Mac development machines
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from ..native import helpers

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".heic", ".tif", ".tiff", ".bmp", ".gif", ".webp"}
MAX_PAGES = 40
enabled = True  # Settings → Knowledge can turn OCR off


class OcrUnavailable(Exception):
    pass


def engine() -> str | None:
    if helpers.helper("nexus-ocr"):
        return "vision"
    if shutil.which("tesseract"):
        return "tesseract"
    return None


def ocr_file(path: Path) -> list[tuple[str | None, str]]:
    """Return [(location, text)] for an image or PDF."""
    if not enabled:
        raise OcrUnavailable("OCR is turned off in Settings")
    binary = helpers.helper("nexus-ocr")
    if binary:
        out = subprocess.run([binary, str(path), str(MAX_PAGES)], capture_output=True, timeout=600)
        if out.returncode != 0:
            raise OcrUnavailable(f"OCR failed: {out.stderr.decode(errors='replace')[:200]}")
        pages = json.loads(out.stdout or b"{}").get("pages", [])
        return [(f"page {p.get('page')}", p.get("text", "")) for p in pages if p.get("text", "").strip()]
    tess = shutil.which("tesseract")
    if not tess:
        raise OcrUnavailable("No OCR engine available (needs Xcode command-line tools on macOS, or tesseract)")
    if path.suffix.lower() == ".pdf":
        ppm = shutil.which("pdftoppm")
        if not ppm:
            raise OcrUnavailable("pdftoppm is required to OCR PDFs with tesseract")
        sections: list[tuple[str | None, str]] = []
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run([ppm, "-r", "150", "-png", "-l", str(MAX_PAGES), str(path), f"{tmp}/p"], capture_output=True, timeout=600, check=True)
            for i, img in enumerate(sorted(Path(tmp).glob("p*.png")), 1):
                text = _tesseract(tess, img)
                if text.strip():
                    sections.append((f"page {i}", text))
        return sections
    text = _tesseract(tess, path)
    return [("page 1", text)] if text.strip() else []


def _tesseract(tess: str, image: Path) -> str:
    out = subprocess.run([tess, str(image), "stdout"], capture_output=True, timeout=300)
    if out.returncode != 0:
        raise OcrUnavailable(f"tesseract failed: {out.stderr.decode(errors='replace')[:200]}")
    return out.stdout.decode(errors="replace")
