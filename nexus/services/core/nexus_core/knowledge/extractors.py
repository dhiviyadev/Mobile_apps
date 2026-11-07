"""Text extraction for supported document formats.

Each extractor returns a list of (location, text) sections so search results
can cite page / sheet / line ranges.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

SUPPORTED = {".txt", ".md", ".markdown", ".csv", ".json", ".pdf", ".docx", ".xlsx", ".rst", ".log", ".tsv"}

Section = tuple[str | None, str]


class ExtractionError(Exception):
    pass


def extract(path: Path, max_chars: int = 2_000_000) -> list[Section]:
    ext = path.suffix.lower()
    if ext not in SUPPORTED:
        raise ExtractionError(f"Unsupported file type {ext}")
    try:
        if ext in {".txt", ".md", ".markdown", ".rst", ".log"}:
            return _text(path, max_chars)
        if ext in {".csv", ".tsv"}:
            return _csv(path, max_chars, delimiter="\t" if ext == ".tsv" else ",")
        if ext == ".json":
            return _json(path, max_chars)
        if ext == ".pdf":
            return _pdf(path, max_chars)
        if ext == ".docx":
            return _docx(path, max_chars)
        if ext == ".xlsx":
            return _xlsx(path, max_chars)
    except ExtractionError:
        raise
    except Exception as exc:  # noqa: BLE001 - corrupt files must not crash indexing
        raise ExtractionError(f"{exc.__class__.__name__}: {exc}") from exc
    raise ExtractionError(f"Unsupported file type {ext}")


def _read_text(path: Path, max_chars: int) -> str:
    raw = path.read_bytes()[: max_chars * 4]
    for enc in ("utf-8", "utf-16", "latin-1"):
        try:
            return raw.decode(enc)[:max_chars]
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")[:max_chars]


def _text(path: Path, max_chars: int) -> list[Section]:
    text = _read_text(path, max_chars)
    lines = text.splitlines()
    sections: list[Section] = []
    block, start = [], 1
    for i, line in enumerate(lines, 1):
        block.append(line)
        if len(block) >= 60:
            sections.append((f"lines {start}-{i}", "\n".join(block)))
            block, start = [], i + 1
    if block:
        sections.append((f"lines {start}-{len(lines)}", "\n".join(block)))
    return sections


def _csv(path: Path, max_chars: int, delimiter: str) -> list[Section]:
    text = _read_text(path, max_chars)
    rows = list(csv.reader(text.splitlines(), delimiter=delimiter))
    if not rows:
        return []
    header = rows[0]
    sections: list[Section] = []
    for start in range(1, len(rows), 40):
        chunk = rows[start : start + 40]
        body = "\n".join(
            "; ".join(f"{h}: {v}" for h, v in zip(header, r, strict=False)) for r in chunk
        )
        sections.append((f"rows {start}-{start + len(chunk) - 1}", f"Columns: {', '.join(header)}\n{body}"))
    if len(rows) == 1:
        sections.append(("header", "Columns: " + ", ".join(header)))
    return sections


def _json(path: Path, max_chars: int) -> list[Section]:
    data = json.loads(_read_text(path, max_chars))
    pretty = json.dumps(data, indent=1, ensure_ascii=False)[:max_chars]
    return [(None, pretty)]


def _pdf(path: Path, max_chars: int) -> list[Section]:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    if reader.is_encrypted:
        raise ExtractionError("PDF is encrypted")
    sections: list[Section] = []
    total = 0
    for i, page in enumerate(reader.pages, 1):
        text = page.extract_text() or ""
        if text.strip():
            sections.append((f"page {i}", text))
            total += len(text)
        if total > max_chars:
            break
    if not sections:
        raise ExtractionError("No extractable text (the PDF may be scanned images; OCR is not yet supported)")
    return sections


def _docx(path: Path, max_chars: int) -> list[Section]:
    import docx

    d = docx.Document(str(path))
    sections: list[Section] = []
    heading = None
    buf: list[str] = []
    for p in d.paragraphs:
        if p.style is not None and p.style.name.lower().startswith("heading") and p.text.strip():
            if buf:
                sections.append((heading, "\n".join(buf)))
                buf = []
            heading = p.text.strip()[:80]
        if p.text.strip():
            buf.append(p.text)
    for ti, table in enumerate(d.tables, 1):
        rows = ["\t".join(c.text for c in row.cells) for row in table.rows]
        sections.append((f"table {ti}", "\n".join(rows)))
    if buf:
        sections.append((heading, "\n".join(buf)))
    return sections


def _xlsx(path: Path, max_chars: int) -> list[Section]:
    import openpyxl

    wb = openpyxl.load_workbook(str(path), read_only=True, data_only=True)
    sections: list[Section] = []
    total = 0
    try:
        for ws in wb.worksheets:
            rows: list[str] = []
            start = 1
            for i, row in enumerate(ws.iter_rows(values_only=True), 1):
                cells = ["" if v is None else str(v) for v in row]
                if any(cells):
                    rows.append("\t".join(cells))
                if len(rows) >= 40:
                    text = "\n".join(rows)
                    sections.append((f"sheet {ws.title} rows {start}-{i}", text))
                    total += len(text)
                    rows, start = [], i + 1
                if total > max_chars:
                    break
            if rows:
                sections.append((f"sheet {ws.title} rows {start}+", "\n".join(rows)))
    finally:
        wb.close()
    return sections


def chunk_sections(sections: list[Section], size: int = 1200, overlap: int = 150) -> list[Section]:
    """Split sections into ~size-char chunks on paragraph/sentence boundaries."""
    chunks: list[Section] = []
    for loc, text in sections:
        text = text.strip()
        if not text:
            continue
        if len(text) <= size:
            chunks.append((loc, text))
            continue
        pos = 0
        while pos < len(text):
            end = min(len(text), pos + size)
            if end < len(text):
                window = text[pos:end]
                cut = max(window.rfind("\n\n"), window.rfind(". "), window.rfind("\n"))
                if cut > size * 0.5:
                    end = pos + cut + 1
            chunks.append((loc, text[pos:end].strip()))
            if end >= len(text):
                break
            pos = max(end - overlap, pos + 1)
    return [c for c in chunks if c[1]]
