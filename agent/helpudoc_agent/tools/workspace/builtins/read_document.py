"""Read the full text of a tagged workspace document.

Grounding replacement for the removed RAG path: when a user @tags a file, the
agent reads the whole document via this tool and answers from it.

For binary documents (.pdf/.docx/.pptx) this extracts the FULL text of the
ORIGINAL file (every page), rather than the lossy Gemini "understanding" summary
stored in the derived artifact — so details like fee tables are not dropped.
"""
from __future__ import annotations

import os
from pathlib import Path

from langchain_core.tools import Tool, tool

from ....configuration import Settings
from ....state import WorkspaceState

DEFAULT_TAGGED_DOC_MAX_CHARS = 200_000

_PDF_SUFFIXES = {".pdf"}
_DOCX_SUFFIXES = {".docx"}
_PPTX_SUFFIXES = {".pptx"}


def _tagged_doc_max_chars() -> int:
    raw = os.getenv("TAGGED_DOC_MAX_CHARS")
    if raw and raw.strip():
        try:
            value = int(raw.strip())
            if value > 0:
                return value
        except ValueError:
            pass
    return DEFAULT_TAGGED_DOC_MAX_CHARS


def _extract_full_text(candidate: Path) -> str:
    """Return the full extracted text of a document, reading the original file.

    Binary formats are fully extracted (all pages) via the same helpers used for
    attachment understanding; text formats are read verbatim.
    """
    suffix = candidate.suffix.lower()
    if suffix in _PDF_SUFFIXES:
        from ....api.attachment_processing import _extract_text_from_pdf

        return _extract_text_from_pdf(candidate.read_bytes())
    if suffix in _DOCX_SUFFIXES:
        from ....api.attachment_processing import _extract_text_from_docx

        return _extract_text_from_docx(candidate.read_bytes())
    if suffix in _PPTX_SUFFIXES:
        from ....api.attachment_processing import _extract_text_from_pptx

        return _extract_text_from_pptx(candidate.read_bytes())
    return candidate.read_text(encoding="utf-8", errors="replace")


def build_read_tagged_document_tool(settings: Settings, workspace_state: WorkspaceState) -> Tool:
    @tool
    async def read_tagged_document(path: str, offset: int = 0) -> str:
        """Read a tagged workspace document's full content to ground your answer.

        Use this for @tagged files. For PDFs (and .docx/.pptx) pass the ORIGINAL
        source path (e.g. `Consumer Credit Act 2025.pdf`) — the whole document is
        extracted (every page), not a summary. For text/markdown pass its path.
        Returns the full document up to a size budget; if longer, the response ends
        with a marker telling you to call again with the given `offset`. Ground
        answers about tagged files strictly in this content.
        """
        if not path or not str(path).strip():
            raise ValueError("path is required")
        rel = str(path).strip().replace("\\", "/").lstrip("/")
        workspace_root = workspace_state.root_path.resolve()
        candidate = (workspace_root / rel).resolve()
        if workspace_root not in candidate.parents and candidate != workspace_root:
            return f"[{path}] [Path is outside the workspace]"
        if not candidate.exists() or not candidate.is_file():
            return f"[{path}] [File not found on disk]"
        try:
            text = _extract_full_text(candidate)
        except Exception as exc:  # noqa: BLE001 - surface extraction errors to the model
            return f"[{path}] [Error extracting document text: {exc}]"

        start = max(0, int(offset or 0))
        window = text[start:start + _tagged_doc_max_chars()]
        end = start + len(window)
        header = f"[{path}] (chars {start}-{end} of {len(text)})\n"
        if end < len(text):
            return (
                f"{header}{window}\n\n"
                f"...[truncated at {end} chars; call read_tagged_document(path=\"{path}\", offset={end}) for more]"
            )
        return f"{header}{window}"

    read_tagged_document.name = "read_tagged_document"
    read_tagged_document.description = (
        "Read the full text of a tagged workspace document to ground answers about @tagged files. "
        "For PDFs/.docx/.pptx it extracts the entire original document (all pages), not a summary. "
        "Supports offset paging for very large files."
    )
    return read_tagged_document
