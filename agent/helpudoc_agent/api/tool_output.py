"""Infer MIME types and structured output paths from tool transcripts."""
from __future__ import annotations

import mimetypes
import re
from typing import Any, Dict, List

from .constants import _FILE_RESULT_PATTERNS


def _infer_mime_type(file_path: str) -> str:
    guessed, _ = mimetypes.guess_type(file_path)
    return guessed or "application/octet-stream"


def _extract_output_files_from_tool_result(name: str, text: str) -> List[Dict[str, Any]]:
    if not text:
        return []
    outputs: List[Dict[str, Any]] = []
    if name == "write_file":
        match = _FILE_RESULT_PATTERNS[0].search(text)
        if match:
            path = match.group("path")
            outputs.append({"path": path.lstrip("/"), "mimeType": _infer_mime_type(path)})
        return outputs
    if name == "edit_file":
        match = _FILE_RESULT_PATTERNS[1].search(text)
        if match:
            path = match.group("path")
            outputs.append({"path": path.lstrip("/"), "mimeType": _infer_mime_type(path)})
        return outputs
    if name == "append_to_report":
        match = _FILE_RESULT_PATTERNS[2].search(text)
        if match:
            path = match.group("dst")
            outputs.append({"path": path.lstrip("/"), "mimeType": _infer_mime_type(path)})
        return outputs
    if name == "create_pdf_from_images":
        match = _FILE_RESULT_PATTERNS[3].search(text)
        if match:
            path = match.group("path")
            outputs.append({"path": path.lstrip("/"), "mimeType": _infer_mime_type(path)})
        return outputs
    return outputs
