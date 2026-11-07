"""DEV ONLY: a stand-in for the Ollama HTTP API, for UI development on machines
without Ollama (e.g. CI or a Linux container). It speaks the documented wire
format (/api/tags, /api/ps, /api/chat NDJSON streaming, /api/generate, /api/embed)
and returns canned text. Never used by NEXUS in normal operation.

    python scripts/dev/fake_ollama.py --port 11434
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

MODELS = [
    {"name": "qwen3:14b", "size": 9_300_000_000, "details": {"family": "qwen3", "families": ["qwen3"], "parameter_size": "14.8B", "quantization_level": "Q4_K_M"}},
    {"name": "gpt-oss:20b", "size": 13_800_000_000, "details": {"family": "gptoss", "families": ["gptoss"], "parameter_size": "20.9B", "quantization_level": "MXFP4"}},
    {"name": "nomic-embed-text:latest", "size": 274_000_000, "details": {"family": "nomic-bert", "families": ["nomic-bert"], "parameter_size": "137M"}},
]
RUNNING: dict[str, dict] = {}

REPLY = """Here's a concise comparison of the two proposals [1]:

| | Proposal A | Proposal B |
|---|---|---|
| Budget | €42,000 | €38,500 |
| Timeline | 12 weeks | 9 weeks |
| Support | 6 months | 3 months |

**Inconsistency:** Proposal B quotes 9 weeks in the summary but its milestone plan adds up to **11 weeks**.

```python
def total_weeks(milestones):
    return sum(m["weeks"] for m in milestones)
```

Would you like me to draft questions for the vendor?"""


async def tags(_: Request) -> JSONResponse:
    return JSONResponse({"models": MODELS})


async def ps(_: Request) -> JSONResponse:
    return JSONResponse({"models": list(RUNNING.values())})


async def version(_: Request) -> JSONResponse:
    return JSONResponse({"version": "0.0.0-dev-fake"})


async def generate(req: Request) -> JSONResponse:
    body = await req.json()
    name = body["model"]
    if body.get("keep_alive") == 0:
        RUNNING.pop(name, None)
    else:
        m = next(x for x in MODELS if x["name"] == name)
        await asyncio.sleep(0.8)
        RUNNING[name] = {"name": name, "size": m["size"], "size_vram": m["size"], "expires_at": "2099-01-01T00:00:00Z", "context_length": 8192}
    return JSONResponse({"model": name, "done": True, "load_duration": 800_000_000})


async def embed(req: Request) -> JSONResponse:
    body = await req.json()
    return JSONResponse({"embeddings": [[float(len(t) % 11), float(t.count("e")), 1.0] for t in body["input"]]})


async def chat(req: Request) -> StreamingResponse:
    body = await req.json()

    async def gen():
        start = time.time()
        words = REPLY.split(" ")
        for i, w in enumerate(words):
            await asyncio.sleep(0.02)
            yield json.dumps({"message": {"role": "assistant", "content": w + (" " if i < len(words) - 1 else "")}, "done": False}) + "\n"
        dur = int((time.time() - start) * 1e9)
        yield json.dumps({"message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop", "total_duration": dur,
                          "load_duration": 5_000_000, "prompt_eval_count": 120, "eval_count": len(words), "eval_duration": dur}) + "\n"

    RUNNING.setdefault(body["model"], {"name": body["model"], "size": 9_300_000_000, "size_vram": 9_300_000_000, "expires_at": "2099-01-01T00:00:00Z"})
    return StreamingResponse(gen(), media_type="application/x-ndjson")


app = Starlette(routes=[
    Route("/api/tags", tags), Route("/api/ps", ps), Route("/api/version", version),
    Route("/api/generate", generate, methods=["POST"]), Route("/api/embed", embed, methods=["POST"]),
    Route("/api/chat", chat, methods=["POST"]),
])

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=11434)
    uvicorn.run(app, host="127.0.0.1", port=ap.parse_args().port, log_level="warning")
