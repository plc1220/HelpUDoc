"""Bounded, read-only inspection tools for workspace documents.

These tools deliberately operate on the original workspace file at agent run
time. They replace the requirement to pre-parse every upload before a chat can
start. Results are location-addressable so the model can cite pages,
paragraphs, sheets, and cells without loading an entire document into context.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Iterable, List, Optional

from langchain_core.tools import Tool, tool

from ....state import WorkspaceState
from .workspace_files import _display_path, _resolve_under_root, _workspace_root


_TEXT_SUFFIXES = {
    ".csv",
    ".html",
    ".htm",
    ".json",
    ".md",
    ".sql",
    ".toml",
    ".tsv",
    ".txt",
    ".yaml",
    ".yml",
}
_MAX_OUTPUT_CHARS = int(os.getenv("DOCUMENT_INSPECTION_MAX_OUTPUT_CHARS", "30000"))
_MAX_SEARCH_RESULTS = int(os.getenv("DOCUMENT_INSPECTION_MAX_SEARCH_RESULTS", "40"))
_MAX_SPREADSHEET_INSPECT_CELLS = int(os.getenv("DOCUMENT_INSPECTION_MAX_RANGE_CELLS", "10000"))
_MAX_SPREADSHEET_SCAN_CELLS = int(os.getenv("DOCUMENT_INSPECTION_MAX_SPREADSHEET_CELLS", "250000"))


def _clip(value: str, limit: int = _MAX_OUTPUT_CHARS) -> str:
    text = str(value or "")
    if limit > 0 and len(text) > limit:
        return text[:limit].rstrip() + "\n\n[Output truncated]"
    return text


def _clean_query(query: str) -> tuple[str, list[str]]:
    phrase = str(query or "").strip().lower()
    tokens = [token for token in re.findall(r"[\w.-]+", phrase) if len(token) > 1]
    return phrase, tokens


def _matches(text: str, phrase: str, tokens: Iterable[str]) -> bool:
    haystack = str(text or "").lower()
    if phrase and phrase in haystack:
        return True
    token_list = list(tokens)
    return bool(token_list) and all(token in haystack for token in token_list)


def _snippet(text: str, phrase: str, limit: int = 500) -> str:
    compact = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(compact) <= limit:
        return compact
    lowered = compact.lower()
    index = lowered.find(phrase) if phrase else -1
    if index < 0:
        index = 0
    start = max(0, index - limit // 3)
    end = min(len(compact), start + limit)
    prefix = "…" if start else ""
    suffix = "…" if end < len(compact) else ""
    return f"{prefix}{compact[start:end].strip()}{suffix}"


def _resolve_document(root: Path, file_path: str) -> Path:
    raw = str(file_path or "").strip().replace("\\", "/")
    if not raw:
        raise ValueError("file_path is required")
    candidate = _resolve_under_root(root, raw)
    if candidate.is_file():
        return candidate

    # A basename is convenient for @mentions, but it must resolve uniquely.
    basename = Path(raw).name
    matches = [
        path.resolve()
        for path in root.rglob(basename)
        if path.is_file() and ".system/document-cache/" not in path.as_posix()
    ]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        options = ", ".join(_display_path(root, item) for item in matches[:10])
        raise ValueError(f"File name is ambiguous. Use one of: {options}")
    raise FileNotFoundError(f"Workspace file not found: {raw}")


def _pdf_outline(reader: Any) -> list[str]:
    labels: list[str] = []

    def visit(items: Any, depth: int = 0) -> None:
        for item in items or []:
            if isinstance(item, list):
                visit(item, depth + 1)
                continue
            title = str(getattr(item, "title", "") or "").strip()
            if title:
                labels.append(f"{'  ' * depth}- {title}")
            if len(labels) >= 100:
                return

    try:
        visit(getattr(reader, "outline", []) or [])
    except Exception:
        return []
    return labels


def _inspect_pdf(path: Path, page_start: int, page_end: int) -> dict[str, Any]:
    from pypdf import PdfReader  # type: ignore

    reader = PdfReader(str(path))
    page_count = len(reader.pages)
    if page_count == 0:
        return {"kind": "pdf", "pageCount": 0, "pages": []}
    start = max(1, page_start)
    end = min(page_count, max(start, page_end))
    pages = []
    for page_number in range(start, end + 1):
        try:
            content = reader.pages[page_number - 1].extract_text() or ""
        except Exception as exc:
            content = f"[Page extraction failed: {exc}]"
        pages.append({"page": page_number, "text": content.strip()})
    metadata = {
        str(key).lstrip("/"): str(value)
        for key, value in dict(getattr(reader, "metadata", {}) or {}).items()
        if value is not None
    }
    return {
        "kind": "pdf",
        "pageCount": page_count,
        "selectedPages": [start, end],
        "metadata": metadata,
        "outline": _pdf_outline(reader),
        "pages": pages,
    }


def _inspect_docx(path: Path, item_start: int, item_end: int) -> dict[str, Any]:
    from docx import Document  # type: ignore

    document = Document(str(path))
    headings = []
    items: list[dict[str, Any]] = []
    start = max(1, item_start)
    end = max(start, item_end)
    for index, paragraph in enumerate(document.paragraphs, start=1):
        text = str(paragraph.text or "").strip()
        if not text:
            continue
        style_name = str(getattr(paragraph.style, "name", "") or "")
        if style_name.lower().startswith("heading"):
            headings.append({"paragraph": index, "style": style_name, "text": text})
        if start <= index <= end:
            items.append({"kind": "paragraph", "index": index, "style": style_name, "text": text})
    for table_index, table in enumerate(document.tables, start=1):
        if table_index < start or table_index > end:
            continue
        rows = []
        for row_index, row in enumerate(table.rows, start=1):
            values = [str(cell.text or "").strip() for cell in row.cells]
            rows.append({"row": row_index, "values": values})
        items.append({"kind": "table", "index": table_index, "rows": rows})
    return {
        "kind": "docx",
        "paragraphCount": len(document.paragraphs),
        "tableCount": len(document.tables),
        "headings": headings[:200],
        "selectedRange": [start, end],
        "selectedItems": items,
    }


def _inspect_xlsx(path: Path, sheet_name: Optional[str], cell_range: Optional[str]) -> dict[str, Any]:
    from openpyxl import load_workbook  # type: ignore
    from openpyxl.utils.cell import range_boundaries  # type: ignore

    workbook = load_workbook(str(path), read_only=True, data_only=False)
    try:
        inventory = [
            {
                "name": sheet.title,
                "maxRow": int(sheet.max_row or 0),
                "maxColumn": int(sheet.max_column or 0),
                "dimensions": sheet.calculate_dimension(),
            }
            for sheet in workbook.worksheets
        ]
        if not sheet_name:
            return {"kind": "xlsx", "sheets": inventory}
        if sheet_name not in workbook.sheetnames:
            raise ValueError(f"Unknown sheet {sheet_name!r}. Available: {', '.join(workbook.sheetnames)}")
        sheet = workbook[sheet_name]
        requested_range = str(cell_range or "").strip() or "A1:J25"
        try:
            min_column, min_row, max_column, max_row = range_boundaries(requested_range)
        except ValueError as exc:
            raise ValueError(f"Invalid spreadsheet cell range: {requested_range}") from exc
        if any(value is None for value in (min_column, min_row, max_column, max_row)):
            raise ValueError("Spreadsheet inspection ranges must include bounded rows and columns")
        cell_count = (max_column - min_column + 1) * (max_row - min_row + 1)
        if cell_count > _MAX_SPREADSHEET_INSPECT_CELLS:
            raise ValueError(
                f"Spreadsheet inspection range is too large ({cell_count} cells); "
                f"request at most {_MAX_SPREADSHEET_INSPECT_CELLS} cells"
            )
        rows = []
        selected = sheet[requested_range]
        if hasattr(selected, "coordinate"):
            selected_rows = ((selected,),)
        else:
            selected_rows = selected
        for row in selected_rows:
            rows.append(
                [
                    {
                        "cell": cell.coordinate,
                        "value": cell.value,
                        "dataType": cell.data_type,
                    }
                    for cell in row
                ]
            )
        return {
            "kind": "xlsx",
            "sheets": inventory,
            "selectedSheet": sheet_name,
            "selectedRange": requested_range,
            "cells": rows,
        }
    finally:
        workbook.close()


def _inspect_text(path: Path, line_start: int, line_end: int) -> dict[str, Any]:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    if not lines:
        return {"kind": "text", "lineCount": 0, "lines": []}
    start = max(1, line_start)
    end = min(len(lines), max(start, line_end))
    return {
        "kind": "text",
        "lineCount": len(lines),
        "selectedLines": [start, end],
        "lines": [{"line": index, "text": lines[index - 1]} for index in range(start, end + 1)],
    }


def _search_pdf(path: Path, phrase: str, tokens: list[str], limit: int) -> list[dict[str, Any]]:
    from pypdf import PdfReader  # type: ignore

    reader = PdfReader(str(path))
    results = []
    for page_number, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception:
            continue
        if _matches(text, phrase, tokens):
            results.append(
                {
                    "location": f"page:{page_number}",
                    "page": page_number,
                    "snippet": _snippet(text, phrase),
                }
            )
        if len(results) >= limit:
            break
    return results


def _search_docx(path: Path, phrase: str, tokens: list[str], limit: int) -> list[dict[str, Any]]:
    from docx import Document  # type: ignore

    document = Document(str(path))
    results = []
    for index, paragraph in enumerate(document.paragraphs, start=1):
        text = str(paragraph.text or "")
        if _matches(text, phrase, tokens):
            results.append(
                {
                    "location": f"paragraph:{index}",
                    "paragraph": index,
                    "style": str(getattr(paragraph.style, "name", "") or ""),
                    "snippet": _snippet(text, phrase),
                }
            )
        if len(results) >= limit:
            return results
    for table_index, table in enumerate(document.tables, start=1):
        for row_index, row in enumerate(table.rows, start=1):
            text = " | ".join(str(cell.text or "").strip() for cell in row.cells)
            if _matches(text, phrase, tokens):
                results.append(
                    {
                        "location": f"table:{table_index}:row:{row_index}",
                        "table": table_index,
                        "row": row_index,
                        "snippet": _snippet(text, phrase),
                    }
                )
            if len(results) >= limit:
                return results
    return results


def _search_xlsx(path: Path, phrase: str, tokens: list[str], limit: int) -> tuple[list[dict[str, Any]], bool]:
    from openpyxl import load_workbook  # type: ignore

    workbook = load_workbook(str(path), read_only=True, data_only=False)
    results: list[dict[str, Any]] = []
    scanned = 0
    truncated = False
    try:
        for sheet in workbook.worksheets:
            for row in sheet.iter_rows():
                for cell in row:
                    scanned += 1
                    if scanned > _MAX_SPREADSHEET_SCAN_CELLS:
                        truncated = True
                        return results, truncated
                    if cell.value is None:
                        continue
                    text = str(cell.value)
                    if _matches(text, phrase, tokens):
                        results.append(
                            {
                                "location": f"sheet:{sheet.title}:cell:{cell.coordinate}",
                                "sheet": sheet.title,
                                "cell": cell.coordinate,
                                "value": cell.value,
                                "dataType": cell.data_type,
                            }
                        )
                    if len(results) >= limit:
                        return results, truncated
    finally:
        workbook.close()
    return results, truncated


def _search_text(path: Path, phrase: str, tokens: list[str], limit: int) -> list[dict[str, Any]]:
    results = []
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8", errors="replace").splitlines(),
        start=1,
    ):
        if _matches(line, phrase, tokens):
            results.append(
                {
                    "location": f"line:{line_number}",
                    "line": line_number,
                    "snippet": _snippet(line, phrase),
                }
            )
        if len(results) >= limit:
            break
    return results


def build_inspect_document_tool(workspace_state: WorkspaceState) -> Tool:
    root = _workspace_root(workspace_state)

    @tool
    def inspect_document(
        file_path: str,
        page_start: int = 1,
        page_end: int = 5,
        item_start: int = 1,
        item_end: int = 40,
        sheet_name: Optional[str] = None,
        cell_range: Optional[str] = None,
    ) -> str:
        """Inspect a bounded range of a PDF, DOCX, XLSX, or text workspace file."""
        try:
            path = _resolve_document(root, file_path)
            suffix = path.suffix.lower()
            if suffix == ".pdf":
                payload = _inspect_pdf(path, page_start, page_end)
            elif suffix == ".docx":
                payload = _inspect_docx(path, item_start, item_end)
            elif suffix in {".xlsx", ".xlsm"}:
                payload = _inspect_xlsx(path, sheet_name, cell_range)
            elif suffix in _TEXT_SUFFIXES:
                payload = _inspect_text(path, item_start, item_end)
            else:
                return (
                    f"Unsupported document type {suffix or '[none]'}. "
                    "Supported: PDF, DOCX, XLSX/XLSM, and text/Markdown/CSV."
                )
            payload["file"] = _display_path(root, path)
            return _clip(json.dumps(payload, ensure_ascii=False, default=str, indent=2))
        except Exception as exc:
            return f"Document inspection failed: {exc}"

    inspect_document.name = "inspect_document"
    inspect_document.description = (
        "Read a bounded range from an original workspace PDF, DOCX, XLSX/XLSM, "
        "or text file. Start with metadata/headings/sheet inventory, then request "
        "only the pages, paragraphs, sheet, or cells needed."
    )
    return inspect_document


def build_search_document_tool(workspace_state: WorkspaceState) -> Tool:
    root = _workspace_root(workspace_state)

    @tool
    def search_document(file_path: str, query: str, max_results: int = 20) -> str:
        """Search an original workspace document and return location-addressable matches."""
        phrase, tokens = _clean_query(query)
        if not phrase:
            return "query is required"
        limit = max(1, min(int(max_results or 20), _MAX_SEARCH_RESULTS))
        try:
            path = _resolve_document(root, file_path)
            suffix = path.suffix.lower()
            truncated = False
            if suffix == ".pdf":
                results = _search_pdf(path, phrase, tokens, limit)
            elif suffix == ".docx":
                results = _search_docx(path, phrase, tokens, limit)
            elif suffix in {".xlsx", ".xlsm"}:
                results, truncated = _search_xlsx(path, phrase, tokens, limit)
            elif suffix in _TEXT_SUFFIXES:
                results = _search_text(path, phrase, tokens, limit)
            else:
                return (
                    f"Unsupported document type {suffix or '[none]'}. "
                    "Supported: PDF, DOCX, XLSX/XLSM, and text/Markdown/CSV."
                )
            payload = {
                "file": _display_path(root, path),
                "query": query,
                "resultCount": len(results),
                "results": results,
                "scanTruncated": truncated,
            }
            return _clip(json.dumps(payload, ensure_ascii=False, default=str, indent=2))
        except Exception as exc:
            return f"Document search failed: {exc}"

    search_document.name = "search_document"
    search_document.description = (
        "Search inside an original PDF, DOCX, XLSX/XLSM, or text workspace file. "
        "Returns page, paragraph, table-row, sheet/cell, or line locations for grounded follow-up inspection."
    )
    return search_document


def build_document_inspection_tools(workspace_state: WorkspaceState) -> List[Tool]:
    return [
        build_inspect_document_tool(workspace_state),
        build_search_document_tool(workspace_state),
    ]
