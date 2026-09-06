"""Narrow write boundary for the UI's separate-draft slide preview workflow."""
from __future__ import annotations

import json
import posixpath
import re
from typing import Any

MARKER = "SLIDE_STYLE_PREVIEW "
READ_TOOLS = frozenset({"ls", "glob", "grep", "read_file", "list_skills", "load_skill", "write_todos", "workflow_action"})


def preview_request(context: dict[str, Any] | None) -> dict[str, str] | None:
    prompt = str((context or {}).get("current_user_prompt") or "")
    match = re.search(r"^SLIDE_STYLE_PREVIEW (.*)$", prompt, re.MULTILINE)
    if not match:
        return None
    # Malformed preview metadata fails closed: no allowed output path.
    try:
        value = json.loads(match.group(1))
        source, output = value["source"], value["output"]
        for item in (source, output):
            if not isinstance(item, str) or not item or "\\" in item or ".." in item.split("/"):
                return {}
        source = posixpath.normpath("/" + source.lstrip("/"))
        output = posixpath.normpath("/" + output.lstrip("/"))
        if (source == output or posixpath.dirname(source) != posixpath.dirname(output)
                or not re.fullmatch(r"\.style-preview-[a-zA-Z0-9-]+\.html", posixpath.basename(output))):
            return {}
        return {"source": source, "output": output}
    except (ValueError, TypeError, KeyError):
        return {}


def preview_tool_error(context: dict[str, Any] | None, name: str, args: Any) -> str | None:
    request = preview_request(context)
    if request is None:
        return None
    if name in READ_TOOLS:
        return None
    if name in {"write_file", "edit_file"} and isinstance(args, dict):
        path = str(args.get("file_path") or args.get("path") or "")
        if path and "\\" not in path and ".." not in path.split("/"):
            if posixpath.normpath("/" + path.lstrip("/")) == request.get("output"):
                return None
    return ("Style preview mode permits reading files and writing only the designated .style-preview HTML draft. "
            "The existing deck and other workspace files are protected. Use read_file and write_file; "
            "do not execute scripts, external tools, or alternate write paths.")
