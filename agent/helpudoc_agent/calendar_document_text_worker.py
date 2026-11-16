"""Fixed, isolated native-text worker. No application imports or model calls."""
from __future__ import annotations

import io
import json
import os
import sys
import zipfile

MAX_INPUT = 8 * 1024 * 1024
MAX_OUTPUT = 12000


class Unsupported(Exception):
    pass


def limits() -> None:
    try:
        import resource
        try:
            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        except (AttributeError, OSError, ValueError):
            # Darwin does not enforce RLIMIT_AS. Only the trusted parent may
            # enable its sampled RSS watchdog; direct worker invocation fails.
            if sys.platform != "darwin" or os.getenv("CALENDAR_DOCUMENT_RSS_WATCHDOG") != "1":
                raise Unsupported()
        for kind, limit in (
            (resource.RLIMIT_CPU, 5),
            (resource.RLIMIT_FSIZE, 64 * 1024),
            (resource.RLIMIT_NOFILE, 32),
            (resource.RLIMIT_CORE, 0),
        ):
            resource.setrlimit(kind, (limit, limit))
            if resource.getrlimit(kind) != (limit, limit):
                raise Unsupported()
    except (ImportError, AttributeError, OSError, ValueError) as exc:
        raise Unsupported() from exc

    def deny_side_effects(event, args):
        if event.startswith("socket.") or event in {"subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn"}:
            raise PermissionError("Document workers cannot use network or subprocesses")
        if event == "open":
            mode = args[1] if len(args) > 1 else "r"
            flags = args[2] if len(args) > 2 else 0
            if isinstance(mode, str) and any(value in mode for value in "wax+") or isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC):
                raise PermissionError("Document workers cannot write files")

    sys.addaudithook(deny_side_effects)


def clip(value: str, units: int) -> str:
    return value[:units].encode("utf-16-le", errors="replace")[:units * 2].decode("utf-16-le", errors="ignore")


class Text:
    def __init__(self):
        self.parts = []
        self.remaining = MAX_OUTPUT
        self.truncated = False

    def add(self, label: str, text: str) -> None:
        value = f"[{label}]\n{text.strip()}\n"
        chosen = clip(value, self.remaining)
        self.parts.append(chosen)
        self.remaining -= len(chosen.encode("utf-16-le")) // 2
        self.truncated |= chosen != value

    def result(self, gaps):
        if self.truncated or self.remaining == 0:
            gaps.append("Document text was limited to 12,000 characters; remaining content was not reviewed.")
        text = "".join(self.parts)
        if not text.strip():
            raise ValueError("No native text")
        return {"text": text, "gaps": gaps[:20]}


def pdf_text(data: bytes):
    from pypdf import PdfReader
    if not data.lstrip().startswith(b"%PDF-"):
        raise ValueError("Invalid PDF")
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        raise ValueError("Encrypted PDF")
    count = len(reader.pages)
    text, gaps = Text(), ["Only native PDF text was inspected; OCR, images, annotations and attachments were not reviewed."]
    if count > 10:
        gaps.append(f"Only the first 10 of {count} PDF pages were considered.")
    for index in range(min(count, 10)):
        if not text.remaining:
            break
        try:
            value = reader.pages[index].extract_text() or ""
        except Exception:
            gaps.append(f"PDF page {index + 1} could not be read and was not reviewed.")
            continue
        if not value.strip():
            gaps.append(f"PDF page {index + 1} had no native text; scanned or visual content was not reviewed.")
            continue
        text.add(f"Page {index + 1}", value)
    return text.result(gaps)


def docx_preflight(data: bytes) -> None:
    with zipfile.ZipFile(io.BytesIO(data)) as package:
        entries = package.infolist()
        if len(entries) > 1024 or sum(item.file_size for item in entries) > 32 * 1024 * 1024:
            raise ValueError("DOCX expansion limit")
        seen = set()
        for entry in entries:
            name = entry.filename
            if name in seen or name.startswith("/") or "\\" in name or ":" in name or "\x00" in name or any(part in {".", ".."} for part in name.split("/")):
                raise ValueError("Invalid package path")
            seen.add(name)
            if entry.flag_bits & 1 or entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED} or entry.file_size > MAX_INPUT:
                raise ValueError("Unsupported package")
            if (entry.external_attr >> 16) & 0o170000 == 0o120000 or entry.file_size > 65536 and entry.file_size > max(1, entry.compress_size) * 200:
                raise ValueError("Unsafe package expansion")
            lowered = name.lower()
            if "/embeddings/" in lowered or "/activex/" in lowered or lowered.endswith("vbaproject.bin"):
                raise ValueError("Embedded active content")
            if lowered.endswith((".xml", ".rels")):
                xml = package.read(entry).upper()
                if b"<!DOCTYPE" in xml or b"<!ENTITY" in xml:
                    raise ValueError("Unsupported XML declaration")
        if "word/document.xml" not in seen:
            raise ValueError("Not a Word document")


def docx_text(data: bytes):
    docx_preflight(data)
    from docx import Document
    document = Document(io.BytesIO(data))
    text, gaps = Text(), ["Only main-document paragraph and table text was inspected; headers, footnotes, comments, images and embedded objects were not reviewed."]
    paragraphs = document.paragraphs
    if len(paragraphs) > 200:
        gaps.append("Only the first 200 main-document paragraphs were considered.")
    for index, paragraph in enumerate(paragraphs[:200], 1):
        if not text.remaining:
            break
        if paragraph.text.strip():
            text.add(f"Paragraph {index}", paragraph.text)
    tables = document.tables
    if len(tables) > 10:
        gaps.append("Only the first 10 main-document tables were considered.")
    cells = 0
    for table_index, table in enumerate(tables[:10], 1):
        if cells >= 200 or not text.remaining:
            break
        if len(table.rows) > 50:
            gaps.append(f"Only the first 50 rows of DOCX table {table_index} were considered.")
        for row_index, row in enumerate(table.rows, 1):
            if row_index > 50 or cells >= 200 or not text.remaining:
                break
            for column, cell in enumerate(row.cells, 1):
                if cells >= 200 or not text.remaining:
                    break
                cells += 1
                if cell.text.strip():
                    text.add(f"Table {table_index}, row {row_index}, cell {column}", cell.text)
    if cells >= 200:
        gaps.append("The DOCX table budget is 200 cells; remaining table content was not reviewed.")
    return text.result(gaps)


def main():
    try:
        limits()
        data = sys.stdin.buffer.read(MAX_INPUT + 1)
        if not data or len(data) > MAX_INPUT:
            raise ValueError("Input limit")
        kind = sys.argv[1] if len(sys.argv) == 2 else ""
        result = pdf_text(data) if kind == "pdf" else docx_text(data) if kind == "docx" else None
        if result is None:
            raise Unsupported()
    except (Unsupported, ImportError):
        result = {"error": "DOCUMENT_TEXT_UNSUPPORTED"}
    except MemoryError:
        result = {"error": "DOCUMENT_TEXT_LIMIT"}
    except Exception:
        result = {"error": "DOCUMENT_TEXT_UNREADABLE"}
    encoded = json.dumps(result, ensure_ascii=False).encode("utf-8")
    if len(encoded) > 65536:
        encoded = b'{"error":"DOCUMENT_TEXT_LIMIT"}'
    sys.stdout.buffer.write(encoded)


if __name__ == "__main__":
    main()
