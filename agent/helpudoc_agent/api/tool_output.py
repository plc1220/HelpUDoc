"""Infer MIME types and structured output paths from tool transcripts."""
from __future__ import annotations

import json
import mimetypes
import re
from typing import Any, Dict, List

from .constants import _FILE_RESULT_PATTERNS


def _infer_mime_type(file_path: str) -> str:
    guessed, _ = mimetypes.guess_type(file_path)
    return guessed or "application/octet-stream"


def _workspace_files_changed_event(
    workspace_id: str,
    files: List[Dict[str, Any]],
) -> Dict[str, Any] | None:
    """Build the semantic stream event emitted after committed workspace writes."""
    paths: List[str] = []
    seen = set()
    for item in files:
        path = str(item.get("path") or "").strip().replace("\\", "/").lstrip("/")
        if not path or path in seen:
            continue
        seen.add(path)
        paths.append(path)
    normalized_workspace_id = str(workspace_id or "").strip()
    if not normalized_workspace_id or not paths:
        return None
    return {
        "type": "workspace_files_changed",
        "workspaceId": normalized_workspace_id,
        "paths": paths,
    }


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
    if name == "run_skill_python_script":
        for match in re.finditer(r"(?m)^Workspace output file:\s*(?P<path>.+?)\s*$", text):
            path = match.group("path").strip()
            if path:
                outputs.append({"path": path.lstrip("/"), "mimeType": _infer_mime_type(path)})
        return outputs
    if name == "document_execute":
        try:
            payload = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return outputs
        if not isinstance(payload, dict) or payload.get("published") is not True:
            return outputs
        path = payload.get("output_path")
        if isinstance(path, str) and path.strip():
            normalized = path.strip().lstrip("/")
            outputs.append({"path": normalized, "mimeType": _infer_mime_type(normalized)})
        return outputs
    return outputs
