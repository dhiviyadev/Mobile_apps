"""Knowledge base: explicit-folder indexing, FTS5 search, optional semantic search.

Semantic retrieval uses Ollama embeddings stored next to the chunks in SQLite
and an in-memory numpy matrix (fine up to ~100k chunks). The `VectorStore`
seam is where Qdrant plugs in once the retrieval workflow is validated.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

import numpy as np

from ..db.database import Database
from ..events import EventBus
from ..permissions.policy import PermissionService
from ..util import new_id, now_iso
from .extractors import SUPPORTED, ExtractionError, chunk_sections, extract

if TYPE_CHECKING:
    from ..models.ollama import OllamaClient
    from ..models.router import ModelRouter

log = logging.getLogger(__name__)

SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build", ".cache", "target", ".Trash"}
HL_START, HL_END = "\u0002", "\u0003"  # highlight markers; the UI renders them safely (no HTML)


STOPWORDS = set("""a an and are as at be but by can could do does did for from had has have how i if in into is it its
me my of on or our please should so than that the their them then there these they this to was we were what when where
which who why will with would you your about tell show find give much many any all""".split())


def fts_query(text: str, mode: str = "and") -> str | None:
    words = [t for t in re.findall(r"[\w][\w'-]*", text.lower()) if len(t) > 1]
    tokens = [t for t in words if t not in STOPWORDS][:16] or words[:16]
    if not tokens:
        return None
    quoted = [f'"{t}"' for t in tokens]
    quoted[-1] = quoted[-1] + "*"  # prefix match on the last word (search-as-you-type)
    return (" OR " if mode == "or" else " ").join(quoted)


class VectorStore(Protocol):
    def search(self, vector: list[float], limit: int) -> list[tuple[int, float]]: ...
    def invalidate(self) -> None: ...


class SQLiteVectorStore:
    def __init__(self, db: Database):
        self.db = db
        self._ids: np.ndarray | None = None
        self._matrix: np.ndarray | None = None
        self._model: str | None = None

    def invalidate(self) -> None:
        self._ids = self._matrix = None

    def _load(self, model: str) -> None:
        rows = self.db.query("SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL AND embedding_model = ?", (model,))
        if not rows:
            self._ids, self._matrix = np.array([], dtype=np.int64), np.zeros((0, 1), dtype=np.float32)
        else:
            self._ids = np.array([r["id"] for r in rows], dtype=np.int64)
            mat = np.vstack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
            norms = np.linalg.norm(mat, axis=1, keepdims=True)
            self._matrix = mat / np.where(norms == 0, 1, norms)
        self._model = model

    def search_model(self, model: str, vector: list[float], limit: int) -> list[tuple[int, float]]:
        if self._matrix is None or self._model != model:
            self._load(model)
        assert self._matrix is not None and self._ids is not None
        if len(self._ids) == 0:
            return []
        q = np.asarray(vector, dtype=np.float32)
        if q.shape[0] != self._matrix.shape[1]:
            return []
        q = q / (np.linalg.norm(q) or 1)
        scores = self._matrix @ q
        top = np.argsort(-scores)[:limit]
        return [(int(self._ids[i]), float(scores[i])) for i in top]

    def search(self, vector: list[float], limit: int) -> list[tuple[int, float]]:
        return self.search_model(self._model or "", vector, limit)


class KnowledgeService:
    def __init__(self, db: Database, bus: EventBus, permissions: PermissionService, max_file_mb: float = 25):
        self.db = db
        self.bus = bus
        self.permissions = permissions
        self.max_file_bytes = int(max_file_mb * 1024 * 1024)
        self.vectors = SQLiteVectorStore(db)
        self._indexing: set[str] = set()

    # -- indexing -----------------------------------------------------------
    @property
    def indexing(self) -> list[str]:
        return sorted(self._indexing)

    async def index_folder(self, folder_id: str, progress: Any = None) -> dict[str, Any]:
        folder = self.permissions.get_folder(folder_id)
        if not folder:
            raise KeyError(folder_id)
        if folder_id in self._indexing:
            raise RuntimeError("This folder is already being indexed")
        self._indexing.add(folder_id)
        self.bus.publish("knowledge.index_started", {"folder_id": folder_id, "path": folder["path"]})
        try:
            stats = await asyncio.to_thread(self._index_folder_sync, folder, progress)
        finally:
            self._indexing.discard(folder_id)
        self.vectors.invalidate()
        self.db.execute("UPDATE folders SET last_indexed_at = ? WHERE id = ?", (now_iso(), folder_id))
        self.bus.publish("knowledge.index_finished", {"folder_id": folder_id, **stats})
        return stats

    def _iter_files(self, root: Path):
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
            for name in filenames:
                if name.startswith(".") or name.startswith("~$"):
                    continue
                p = Path(dirpath) / name
                if p.suffix.lower() in SUPPORTED:
                    yield p

    def _index_folder_sync(self, folder: dict[str, Any], progress: Any) -> dict[str, Any]:
        conn = self.db.connect()  # separate connection for the worker thread
        root = Path(folder["path"])
        stats = {"scanned": 0, "indexed": 0, "unchanged": 0, "skipped": 0, "failed": 0, "removed": 0, "chunks": 0}
        seen: set[str] = set()
        try:
            for path in self._iter_files(root):
                stats["scanned"] += 1
                spath = str(path)
                if not self.permissions.is_allowed(path, "read"):
                    stats["skipped"] += 1
                    continue
                seen.add(spath)
                try:
                    st = path.stat()
                except OSError:
                    stats["failed"] += 1
                    continue
                existing = conn.execute("SELECT id, size, mtime FROM documents WHERE path = ?", (spath,)).fetchone()
                if existing and existing["size"] == st.st_size and abs(existing["mtime"] - st.st_mtime) < 1e-3:
                    stats["unchanged"] += 1
                    continue
                if st.st_size > self.max_file_bytes:
                    stats["skipped"] += 1
                    continue
                doc_id = existing["id"] if existing else new_id("doc")
                error = None
                chunks: list[tuple[str | None, str]] = []
                try:
                    chunks = chunk_sections(extract(path))
                except ExtractionError as exc:
                    error = str(exc)
                sha = hashlib.sha256(path.read_bytes()).hexdigest() if st.st_size < 64 * 1024 * 1024 else ""
                conn.execute("BEGIN IMMEDIATE")
                try:
                    if existing:
                        conn.execute("DELETE FROM chunks WHERE document_id = ?", (doc_id,))
                        conn.execute(
                            "UPDATE documents SET size=?, mtime=?, sha256=?, chunk_count=?, error=?, indexed_at=?, project=? WHERE id=?",
                            (st.st_size, st.st_mtime, sha, len(chunks), error, now_iso(), folder["project"], doc_id),
                        )
                    else:
                        conn.execute(
                            "INSERT INTO documents(id, folder_id, path, title, ext, size, mtime, sha256, project, chunk_count, error, indexed_at) "
                            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                            (doc_id, folder["id"], spath, path.stem, path.suffix.lower(), st.st_size, st.st_mtime, sha,
                             folder["project"], len(chunks), error, now_iso()),
                        )
                    conn.executemany(
                        "INSERT INTO chunks(document_id, ordinal, content, location) VALUES (?,?,?,?)",
                        [(doc_id, i, text, loc) for i, (loc, text) in enumerate(chunks)],
                    )
                    conn.execute("COMMIT")
                except Exception:
                    conn.execute("ROLLBACK")
                    raise
                if error:
                    stats["failed"] += 1
                else:
                    stats["indexed"] += 1
                    stats["chunks"] += len(chunks)
                if progress and stats["scanned"] % 25 == 0:
                    progress(stats)
            # Remove documents that disappeared from disk.
            for row in conn.execute("SELECT id, path FROM documents WHERE folder_id = ?", (folder["id"],)).fetchall():
                if row["path"] not in seen:
                    conn.execute("DELETE FROM documents WHERE id = ?", (row["id"],))
                    stats["removed"] += 1
        finally:
            conn.close()
        return stats

    # -- embeddings ---------------------------------------------------------
    async def build_embeddings(self, ollama: "OllamaClient", model: str, batch: int = 32, limit: int | None = None) -> dict[str, Any]:
        done = 0
        while True:
            rows = self.db.query(
                "SELECT id, content FROM chunks WHERE embedding IS NULL OR embedding_model != ? LIMIT ?", (model, batch)
            )
            if not rows:
                break
            vectors = await ollama.embed(model, [r["content"][:4000] for r in rows])
            if len(vectors) != len(rows):
                raise RuntimeError("Embedding count mismatch from Ollama")
            self.db.executemany(
                "UPDATE chunks SET embedding = ?, embedding_model = ? WHERE id = ?",
                [(np.asarray(v, dtype=np.float32).tobytes(), model, r["id"]) for v, r in zip(vectors, rows, strict=True)],
            )
            done += len(rows)
            self.bus.publish("knowledge.embedding_progress", {"embedded": done})
            if limit and done >= limit:
                break
        self.vectors.invalidate()
        return {"embedded": done, "model": model}

    def embedding_coverage(self) -> dict[str, Any]:
        row = self.db.query_one(
            "SELECT COUNT(*) AS total, SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded FROM chunks"
        )
        return {"total": row["total"] if row else 0, "embedded": (row["embedded"] or 0) if row else 0}

    # -- search -------------------------------------------------------------
    def _hydrate(self, chunk_ids: list[int]) -> dict[int, dict[str, Any]]:
        if not chunk_ids:
            return {}
        marks = ",".join("?" * len(chunk_ids))
        rows = self.db.query(
            f"SELECT c.id AS chunk_id, c.content, c.location, d.id AS document_id, d.path, d.title, d.ext, d.project "
            f"FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id IN ({marks})",
            chunk_ids,
        )
        return {r["chunk_id"]: r for r in rows}

    def search_fts(self, query: str, limit: int = 10, project: str | None = None) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for mode in ("and", "or"):
            q = fts_query(query, mode)
            if not q:
                return []
            params: list[Any] = [HL_START, HL_END, q]
            proj = ""
            if project:
                proj = "AND d.project = ?"
                params.append(project)
            params.append(limit)
            results = self.db.query(
                f"SELECT c.id AS chunk_id, d.id AS document_id, d.path, d.title, d.ext, d.project, c.location, "
                f"snippet(chunks_fts, 0, ?, ?, '…', 28) AS snippet, bm25(chunks_fts) AS score "
                f"FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN documents d ON d.id = c.document_id "
                f"WHERE chunks_fts MATCH ? {proj} ORDER BY score LIMIT ?",
                params,
            )
            if results:
                break
        return [{**r, "match": "keyword", "score": float(f"{-r['score']:.6g}")} for r in results]

    async def search(self, query: str, limit: int = 10, mode: str = "auto", project: str | None = None,
                     ollama: "OllamaClient | None" = None, router: "ModelRouter | None" = None,
                     record: bool = True) -> dict[str, Any]:
        """mode: keyword | semantic | hybrid | auto (hybrid if embeddings exist, else keyword)."""
        keyword = self.search_fts(query, limit=limit * 2, project=project)
        semantic: list[dict[str, Any]] = []
        used_mode = "keyword"
        note = None
        want_semantic = mode in ("semantic", "hybrid") or (mode == "auto" and self.embedding_coverage()["embedded"] > 0)
        if want_semantic and ollama and router:
            try:
                model = await router.resolve("embeddings")
                vec = (await ollama.embed(model, [query]))[0]
                hits = self.vectors.search_model(model, vec, limit * 2)
                info = self._hydrate([cid for cid, _ in hits])
                for cid, score in hits:
                    if cid in info and (not project or info[cid]["project"] == project):
                        r = info[cid]
                        semantic.append({**{k: r[k] for k in ("chunk_id", "document_id", "path", "title", "ext", "project", "location")},
                                         "snippet": r["content"][:320], "score": round(score, 4), "match": "semantic"})
                used_mode = "semantic" if mode == "semantic" else "hybrid"
            except Exception as exc:  # noqa: BLE001
                note = f"Semantic search unavailable: {exc}"
        if used_mode == "semantic":
            merged = semantic[:limit]
        elif used_mode == "hybrid":
            merged = _rrf(keyword, semantic)[:limit]
        else:
            merged = keyword[:limit]
        if record:
            self.db.execute("INSERT INTO search_history(query, mode, result_count, created_at) VALUES (?,?,?,?)",
                            (query, used_mode, len(merged), now_iso()))
        return {"query": query, "mode": used_mode, "results": merged, "note": note}

    def search_history(self, limit: int = 20) -> list[dict[str, Any]]:
        return self.db.query("SELECT * FROM search_history ORDER BY id DESC LIMIT ?", (limit,))

    def documents(self, folder_id: str | None = None, limit: int = 200, offset: int = 0) -> list[dict[str, Any]]:
        if folder_id:
            return self.db.query("SELECT * FROM documents WHERE folder_id = ? ORDER BY path LIMIT ? OFFSET ?", (folder_id, limit, offset))
        return self.db.query("SELECT * FROM documents ORDER BY indexed_at DESC LIMIT ? OFFSET ?", (limit, offset))

    def document(self, doc_id: str) -> dict[str, Any] | None:
        doc = self.db.query_one("SELECT * FROM documents WHERE id = ?", (doc_id,))
        if doc:
            doc["chunks"] = self.db.query(
                "SELECT ordinal, location, substr(content, 1, 600) AS preview FROM chunks WHERE document_id = ? ORDER BY ordinal LIMIT 50",
                (doc_id,),
            )
        return doc

    def stats(self) -> dict[str, Any]:
        row = self.db.query_one(
            "SELECT (SELECT COUNT(*) FROM documents) AS documents, (SELECT COUNT(*) FROM chunks) AS chunks, "
            "(SELECT COUNT(*) FROM documents WHERE error IS NOT NULL) AS failed, (SELECT COUNT(*) FROM folders) AS folders"
        )
        return {**(row or {}), "embeddings": self.embedding_coverage(), "indexing": self.indexing,
                "projects": [r["project"] for r in self.db.query("SELECT DISTINCT project FROM documents WHERE project IS NOT NULL")]}


def _rrf(a: list[dict[str, Any]], b: list[dict[str, Any]], k: int = 60) -> list[dict[str, Any]]:
    scores: dict[int, float] = {}
    items: dict[int, dict[str, Any]] = {}
    for lst in (a, b):
        for rank, item in enumerate(lst):
            cid = item["chunk_id"]
            scores[cid] = scores.get(cid, 0) + 1 / (k + rank + 1)
            if cid not in items:
                items[cid] = item
            elif items[cid]["match"] != item["match"]:
                items[cid] = {**items[cid], "match": "hybrid"}
    ordered = sorted(scores, key=lambda c: -scores[c])
    return [{**items[c], "score": round(scores[c], 5)} for c in ordered]
