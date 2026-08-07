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
_DEFAULT_XLSX_RANGE = "A1:J25"

_SUPPORTED_TYPES_HINT = "Supported: PDF, DOCX, XLSX/XLSM, and text/Markdown/CSV."

# Stable machine-readable error codes. Callers (skills, prompts, and the
# runtime loop guard) branch on these, so values must not be renamed.
ERROR_FILE_NOT_FOUND = "FILE_NOT_FOUND"
ERROR_AMBIGUOUS_FILE_PATH = "AMBIGUOUS_FILE_PATH"
ERROR_PATH_OUTSIDE_WORKSPACE = "PATH_OUTSIDE_WORKSPACE"
ERROR_UNSUPPORTED_DOCUMENT_TYPE = "UNSUPPORTED_DOCUMENT_TYPE"
ERROR_UNKNOWN_SHEET = "UNKNOWN_SHEET"
ERROR_INVALID_RANGE = "INVALID_RANGE"
ERROR_RANGE_TOO_LARGE = "RANGE_TOO_LARGE"
ERROR_MISSING_QUERY = "MISSING_QUERY"
ERROR_INVALID_ARGUMENT = "INVALID_ARGUMENT"
ERROR_DEPENDENCY_MISSING = "DEPENDENCY_MISSING"
ERROR_DOCUMENT_READ_FAILED = "DOCUMENT_READ_FAILED"

_INSPECT_FAILURE_PREFIX = "Document inspection failed"
_SEARCH_FAILURE_PREFIX = "Document search failed"


class DocumentToolError(Exception):
    """Error carrying a stable code and a recovery hint for the model."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        suggested_next_call: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.suggested_next_call = suggested_next_call


def _short_error(exc: BaseException) -> str:
    return str(exc).strip() or exc.__class__.__name__


def _default_next_call(code: str, tool_name: str) -> str:
    if code in {ERROR_FILE_NOT_FOUND, ERROR_AMBIGUOUS_FILE_PATH, ERROR_PATH_OUTSIDE_WORKSPACE}:
        return "ls(path='/') to confirm the exact workspace-relative file path"
    if code == ERROR_UNSUPPORTED_DOCUMENT_TYPE:
        return "none: ask the user for a supported export (PDF, DOCX, XLSX, CSV, or text)"
    if code == ERROR_UNKNOWN_SHEET:
        return "inspect_document(file_path=<same file>) to list the available sheets"
    if code in {ERROR_INVALID_RANGE, ERROR_RANGE_TOO_LARGE}:
        return "inspect_document(file_path=<same file>, sheet_name=<sheet>, cell_range='A1:J25')"
    if code == ERROR_MISSING_QUERY:
        return "search_document(file_path=<same file>, query=<non-empty search text>)"
    if code == ERROR_DEPENDENCY_MISSING:
        return "none: report the missing document dependency instead of retrying"
    if code == ERROR_DOCUMENT_READ_FAILED:
        return f"{tool_name} once more with a smaller bounded range, then stop and report the failure"
    return "none: report the error instead of repeating the same call"


def _classify_error(exc: BaseException) -> tuple[str, bool]:
    if isinstance(exc, FileNotFoundError):
        return ERROR_FILE_NOT_FOUND, False
    if isinstance(exc, (ImportError, ModuleNotFoundError)):
        return ERROR_DEPENDENCY_MISSING, False
    if isinstance(exc, ValueError):
        text = str(exc).lower()
        if "remain inside the workspace" in text:
            return ERROR_PATH_OUTSIDE_WORKSPACE, False
        if "ambiguous" in text:
            return ERROR_AMBIGUOUS_FILE_PATH, False
        return ERROR_INVALID_ARGUMENT, False
    if isinstance(exc, OSError):
        return ERROR_DOCUMENT_READ_FAILED, True
    return ERROR_DOCUMENT_READ_FAILED, False


def _ok_envelope(payload: dict[str, Any]) -> str:
    """Success envelope: existing keys are preserved and ``status`` is added."""
    body = {"status": "ok"}
    body.update(payload)
    return _clip(json.dumps(body, ensure_ascii=False, default=str, indent=2))


def _error_envelope(tool_name: str, legacy_prefix: str, exc: BaseException) -> str:
    if isinstance(exc, DocumentToolError):
        code = exc.code
        retryable = exc.retryable
        suggested = exc.suggested_next_call or _default_next_call(code, tool_name)
    else:
        code, retryable = _classify_error(exc)
        suggested = _default_next_call(code, tool_name)
    body = {
        "status": "error",
        "tool": tool_name,
        # The legacy prefix is retained so older string-matching callers and
        # transcripts keep working after the envelope change.
        "message": f"{legacy_prefix}: {_short_error(exc)}",
        "errorCode": code,
        "retryable": retryable,
        "suggestedNextCall": suggested,
    }
    return _clip(json.dumps(body, ensure_ascii=False, default=str, indent=2))


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
        raise DocumentToolError(ERROR_INVALID_ARGUMENT, "file_path is required")
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
        raise DocumentToolError(
            ERROR_AMBIGUOUS_FILE_PATH,
            f"File name is ambiguous. Use one of: {options}",
        )
    raise DocumentToolError(ERROR_FILE_NOT_FOUND, f"Workspace file not found: {raw}")


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


def _sheet_dimensions(sheet: Any, *, allow_force: bool) -> tuple[Optional[str], Optional[str]]:
    """Return ``(dimensions, error)`` for one sheet without ever raising.

    ``read_only`` workbooks produced by Google Drive/Sheets exports often omit
    the ``<dimension>`` element, and ``calculate_dimension()`` then raises. The
    ``force=True`` fallback scans the sheet, so it is only used when the caller
    is already paying for a full inventory pass.
    """
    try:
        dimensions = sheet.calculate_dimension()
        if dimensions:
            return str(dimensions), None
        first_error = "Worksheet returned an empty dimension"
    except Exception as exc:  # openpyxl raises ValueError for unsized sheets
        first_error = _short_error(exc)
    if not allow_force:
        return None, first_error
    try:
        return str(sheet.calculate_dimension(force=True)), None
    except TypeError:
        # Non read-only worksheets do not accept ``force``.
        return None, first_error
    except Exception as exc:
        return None, _short_error(exc)


def _sheet_inventory_entry(sheet: Any, *, allow_force: bool) -> dict[str, Any]:
    from openpyxl.utils.cell import range_boundaries  # type: ignore

    entry: dict[str, Any] = {"name": str(getattr(sheet, "title", "") or "")}
    dimensions, dimensions_error = _sheet_dimensions(sheet, allow_force=allow_force)
    max_row = getattr(sheet, "max_row", None)
    max_column = getattr(sheet, "max_column", None)
    if dimensions and (max_row is None or max_column is None):
        try:
            _, _, bounded_column, bounded_row = range_boundaries(str(dimensions))
            max_column = max_column if max_column is not None else bounded_column
            max_row = max_row if max_row is not None else bounded_row
        except Exception:
            pass
    entry["maxRow"] = int(max_row) if isinstance(max_row, int) else None
    entry["maxColumn"] = int(max_column) if isinstance(max_column, int) else None
    entry["dimensions"] = dimensions
    if dimensions_error:
        # Partial metadata is more useful than failing the whole inspection.
        entry["dimensionsError"] = dimensions_error
    return entry


def _xlsx_inventory(workbook: Any, *, allow_force: bool) -> list[dict[str, Any]]:
    inventory: list[dict[str, Any]] = []
    for sheet in getattr(workbook, "worksheets", []) or []:
        try:
            inventory.append(_sheet_inventory_entry(sheet, allow_force=allow_force))
        except Exception as exc:  # never let one sheet break the others
            inventory.append(
                {
                    "name": str(getattr(sheet, "title", "") or ""),
                    "maxRow": None,
                    "maxColumn": None,
                    "dimensions": None,
                    "dimensionsError": _short_error(exc),
                }
            )
    return inventory


def _read_xlsx_range(sheet: Any, requested_range: str) -> list[list[dict[str, Any]]]:
    from openpyxl.utils import get_column_letter  # type: ignore
    from openpyxl.utils.cell import range_boundaries  # type: ignore

    try:
        min_column, min_row, max_column, max_row = range_boundaries(requested_range)
    except ValueError as exc:
        raise DocumentToolError(
            ERROR_INVALID_RANGE,
            f"Invalid spreadsheet cell range: {requested_range}",
        ) from exc
    if any(value is None for value in (min_column, min_row, max_column, max_row)):
        raise DocumentToolError(
            ERROR_INVALID_RANGE,
            "Spreadsheet inspection ranges must include bounded rows and columns",
        )
    cell_count = (max_column - min_column + 1) * (max_row - min_row + 1)
    if cell_count > _MAX_SPREADSHEET_INSPECT_CELLS:
        raise DocumentToolError(
            ERROR_RANGE_TOO_LARGE,
            f"Spreadsheet inspection range is too large ({cell_count} cells); "
            f"request at most {_MAX_SPREADSHEET_INSPECT_CELLS} cells",
        )
    rows: list[list[dict[str, Any]]] = []
    # Explicit bounds keep this read independent of sheet dimension discovery,
    # and coordinates are derived from the bounds so padded/empty cells (which
    # carry no row/column of their own) stay addressable.
    iterator = sheet.iter_rows(
        min_row=min_row,
        max_row=max_row,
        min_col=min_column,
        max_col=max_column,
    )
    for row_offset, row in enumerate(iterator):
        row_number = min_row + row_offset
        cells: list[dict[str, Any]] = []
        for column_offset, cell in enumerate(row or ()):
            column_number = min_column + column_offset
            cells.append(
                {
                    "cell": f"{get_column_letter(column_number)}{row_number}",
                    "value": getattr(cell, "value", None),
                    "dataType": getattr(cell, "data_type", None),
                }
            )
        rows.append(cells)
    return rows


def _inspect_xlsx(path: Path, sheet_name: Optional[str], cell_range: Optional[str]) -> dict[str, Any]:
    from openpyxl import load_workbook  # type: ignore

    workbook = load_workbook(str(path), read_only=True, data_only=False)
    try:
        if not sheet_name:
            return {"kind": "xlsx", "sheets": _xlsx_inventory(workbook, allow_force=True)}
        if sheet_name not in workbook.sheetnames:
            raise DocumentToolError(
                ERROR_UNKNOWN_SHEET,
                f"Unknown sheet {sheet_name!r}. Available: {', '.join(workbook.sheetnames)}",
            )
        sheet = workbook[sheet_name]
        requested_range = str(cell_range or "").strip() or _DEFAULT_XLSX_RANGE
        # The targeted read runs first and never depends on dimension discovery.
        rows = _read_xlsx_range(sheet, requested_range)
        return {
            "kind": "xlsx",
            "sheets": _xlsx_inventory(workbook, allow_force=False),
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
                raise DocumentToolError(
                    ERROR_UNSUPPORTED_DOCUMENT_TYPE,
                    f"Unsupported document type {suffix or '[none]'}. {_SUPPORTED_TYPES_HINT}",
                )
            payload["file"] = _display_path(root, path)
            return _ok_envelope(payload)
        except Exception as exc:
            return _error_envelope("inspect_document", _INSPECT_FAILURE_PREFIX, exc)

    inspect_document.name = "inspect_document"
    inspect_document.description = (
        "Read a bounded range from an original workspace PDF, DOCX, XLSX/XLSM, "
        "or text file. Start with metadata/headings/sheet inventory, then request "
        "only the pages, paragraphs, sheet, or cells needed. Returns JSON with "
        "status='ok', or status='error' plus errorCode, retryable, and "
        "suggestedNextCall. Do not repeat a call whose error is not retryable."
    )
    return inspect_document


def build_search_document_tool(workspace_state: WorkspaceState) -> Tool:
    root = _workspace_root(workspace_state)

    @tool
    def search_document(file_path: str, query: str, max_results: int = 20) -> str:
        """Search an original workspace document and return location-addressable matches."""
        phrase, tokens = _clean_query(query)
        if not phrase:
            return _error_envelope(
                "search_document",
                _SEARCH_FAILURE_PREFIX,
                DocumentToolError(ERROR_MISSING_QUERY, "query is required"),
            )
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
                raise DocumentToolError(
                    ERROR_UNSUPPORTED_DOCUMENT_TYPE,
                    f"Unsupported document type {suffix or '[none]'}. {_SUPPORTED_TYPES_HINT}",
                )
            payload = {
                "file": _display_path(root, path),
                "query": query,
                "resultCount": len(results),
                "results": results,
                "scanTruncated": truncated,
            }
            return _ok_envelope(payload)
        except Exception as exc:
            return _error_envelope("search_document", _SEARCH_FAILURE_PREFIX, exc)

    search_document.name = "search_document"
    search_document.description = (
        "Search inside an original PDF, DOCX, XLSX/XLSM, or text workspace file. "
        "Returns page, paragraph, table-row, sheet/cell, or line locations for grounded follow-up inspection. "
        "Returns JSON with status='ok', or status='error' plus errorCode, retryable, "
        "and suggestedNextCall. Do not repeat a call whose error is not retryable."
    )
    return search_document


def build_document_inspection_tools(workspace_state: WorkspaceState) -> List[Tool]:
    return [
        build_inspect_document_tool(workspace_state),
        build_search_document_tool(workspace_state),
    ]
