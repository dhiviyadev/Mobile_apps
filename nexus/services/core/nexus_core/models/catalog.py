"""Suggested models. These are only *suggestions* shown in the model manager — NEXUS still
discovers whatever is installed, and any Ollama model name can be typed in. Sizes are approximate
download sizes for the default 4-bit builds; the fit verdict uses this Mac's actual memory."""

from __future__ import annotations

from typing import Any

import psutil

GB = 1024**3

SUGGESTED: list[dict[str, Any]] = [
    {"name": "qwen3:14b", "label": "Qwen 3 · 14B", "size_gb": 9.3, "role": "general",
     "note": "Reliable everyday assistant with dependable tool use."},
    {"name": "gemma4:26b", "label": "Gemma 4 · 26B", "size_gb": 18.0, "role": "general", "vision": True,
     "note": "Smarter and can read images, but tight on 24 GB."},
    {"name": "gpt-oss:20b", "label": "GPT-OSS · 20B", "size_gb": 13.8, "role": "reasoning",
     "note": "Stronger reasoning; best with other heavy apps closed."},
    {"name": "qwen2.5-coder:14b", "label": "Qwen 2.5 Coder · 14B", "size_gb": 9.0, "role": "coding",
     "note": "Code-focused."},
    {"name": "qwen3:4b", "label": "Qwen 3 · 4B", "size_gb": 2.6, "role": "classification",
     "note": "Fast and light for automations and memory suggestions."},
    {"name": "nomic-embed-text", "label": "Nomic Embed", "size_gb": 0.3, "role": "embeddings",
     "note": "Lets document search match meaning, not just keywords."},
]


def fit(size_gb: float, total_bytes: int | None = None) -> str:
    """fits | tight | too_big for this machine's total memory (models share RAM with macOS and apps)."""
    total = (total_bytes or psutil.virtual_memory().total) / GB
    if size_gb <= total * 0.5:
        return "fits"
    if size_gb <= total * 0.8:
        return "tight"
    return "too_big"


def catalog(installed: set[str], total_bytes: int | None = None) -> list[dict[str, Any]]:
    out = []
    for m in SUGGESTED:
        base = m["name"]
        is_installed = base in installed or f"{base}:latest" in installed or any(i.split(":")[0] == base for i in installed if ":" not in base)
        out.append({**m, "fit": fit(m["size_gb"], total_bytes), "installed": is_installed})
    return out
