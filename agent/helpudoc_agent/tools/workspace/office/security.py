"""Workspace path and OfficeCLI operation validation."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .models import (
    ALLOWED_COMMANDS,
    BLOCKED_FIELDS,
    BLOCKED_NESTED_KEYS,
    COMMAND_FIELD_ALLOWLISTS,
)

# Extensions we accept as valid Office documents.
VALID_EXTENSIONS = frozenset({".docx", ".xlsx", ".pptx"})


class PathTraversalError(Exception):
    """Raised when a resolved path escapes the workspace boundary."""


class InvalidOperationError(Exception):
    """Raised when an operation contains disallowed fields or commands."""


def resolve_workspace_path(workspace_root: str, workspace_id: str, relative_path: str) -> Path:
    """Resolve a workspace-relative path with strict containment checks.

    - No absolute paths
    - No '..' segments
    - No symlink escape
    - Must resolve within workspace_root/workspace_id/
    """
    if not relative_path:
        raise PathTraversalError("Path must not be empty")

    if os.path.isabs(relative_path):
        raise PathTraversalError("Absolute paths are not allowed")

    if ".." in Path(relative_path).parts:
        raise PathTraversalError("Path must not contain '..' segments")

    base = Path(workspace_root) / workspace_id
    workspace_root_resolved = Path(workspace_root).resolve(strict=False)
    base_resolved = base.resolve(strict=False)

    # Verify workspace base itself stays under workspace_root (workspace_id could be symlink)
    if base_resolved != workspace_root_resolved and workspace_root_resolved not in base_resolved.parents:
        raise PathTraversalError(
            f"Workspace '{workspace_id}' resolves outside workspace root"
        )

    target = (base / relative_path).resolve(strict=False)

    # Containment: target must be strictly under base_resolved
    if target == base_resolved or base_resolved not in target.parents:
        raise PathTraversalError(
            f"Path '{relative_path}' does not resolve inside workspace '{workspace_id}'"
        )

    # Check for symlink escape: resolve the actual path if it exists
    if target.exists():
        real_target = target.resolve(strict=True)
        if real_target != target and base_resolved not in real_target.parents:
            raise PathTraversalError(
                f"Symlink at '{relative_path}' escapes workspace boundary"
            )

    return target


def validate_extension(path_str: str, context: str = "path") -> None:
    """Ensure the file has a valid Office document extension."""
    ext = Path(path_str).suffix.lower()
    if ext not in VALID_EXTENSIONS:
        raise InvalidOperationError(
            f"{context} must have extension in {sorted(VALID_EXTENSIONS)}, got '{ext}'"
        )


def validate_operations(operations: list[dict[str, Any]], max_operations: int) -> None:
    """Validate a list of batch operations for safety.

    - Enforce operation count limit
    - Validate each operation has an allowed command
    - Reject top-level blocked fields (filesystem/network bearing)
    - Per-command field allowlist check
    - Recursively reject blocked nested keys in props and other sub-dicts
    """
    if len(operations) > max_operations:
        raise InvalidOperationError(
            f"Too many operations: {len(operations)} exceeds limit of {max_operations}"
        )

    for i, op_dict in enumerate(operations):
        # Determine the command name
        cmd_name = op_dict.get("command") or op_dict.get("op")
        if not cmd_name:
            raise InvalidOperationError(
                f"Operation at index {i} must have 'command' (or 'op') field"
            )
        if not isinstance(cmd_name, str):
            raise InvalidOperationError(
                f"Operation at index {i} command must be a string"
            )

        # Reject ambiguity: OfficeCLI's converter permits one alias to overwrite
        # the other, so accepting both makes the effective command order-dependent.
        if "command" in op_dict and "op" in op_dict:
            raise InvalidOperationError(
                f"Operation at index {i} must not contain both 'command' and 'op'"
            )

        if cmd_name not in ALLOWED_COMMANDS:
            raise InvalidOperationError(
                f"Command '{cmd_name}' at index {i} is not allowed. "
                f"Allowed: {sorted(ALLOWED_COMMANDS)}"
            )

        # Check for blocked filesystem/network fields at top level
        blocked_found = set(op_dict.keys()) & BLOCKED_FIELDS
        if blocked_found:
            raise InvalidOperationError(
                f"Operation at index {i} contains blocked fields: {sorted(blocked_found)}"
            )

        # OfficeCLI accepts either a JSON object or key=value string array.
        if "props" in op_dict:
            props = op_dict["props"]
            valid_array = isinstance(props, list) and all(
                isinstance(item, str) and "=" in item for item in props
            )
            if not isinstance(props, dict) and not valid_array:
                raise InvalidOperationError(
                    f"Operation '{cmd_name}' at index {i}: 'props' must be an object or "
                    f"a key=value string array, got {type(props).__name__}"
                )

        # Per-command field allowlist
        allowed_for_cmd = COMMAND_FIELD_ALLOWLISTS.get(cmd_name, frozenset())
        all_allowed = allowed_for_cmd | {"command", "op"}
        unknown = set(op_dict.keys()) - all_allowed
        if unknown:
            raise InvalidOperationError(
                f"Operation '{cmd_name}' at index {i} contains fields not allowed for "
                f"this command: {sorted(unknown)}. Allowed: {sorted(allowed_for_cmd)}"
            )

        # Recursively check nested dicts for blocked keys
        for key, value in op_dict.items():
            if key in ("command", "op"):
                continue
            if isinstance(value, (dict, list)):
                _validate_nested(value, i, cmd_name, depth=1)


def _validate_nested(obj: Any, op_index: int, cmd_name: str, depth: int = 0) -> None:
    """Recursively validate nested structures for blocked keys.

    BLOCKED_NESTED_KEYS includes 'path' — it is only legal at the top-level
    command field, never nested inside props or other sub-objects.
    """
    if depth > 5:
        raise InvalidOperationError(
            f"Operation '{cmd_name}' at index {op_index}: nested structure too deep"
        )

    if isinstance(obj, dict):
        for key, value in obj.items():
            if key.lower() in BLOCKED_NESTED_KEYS:
                raise InvalidOperationError(
                    f"Operation '{cmd_name}' at index {op_index}: "
                    f"nested key '{key}' is blocked (potential filesystem/network reference)"
                )
            if isinstance(value, (dict, list)):
                _validate_nested(value, op_index, cmd_name, depth + 1)
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, (dict, list)):
                _validate_nested(item, op_index, cmd_name, depth + 1)
            elif isinstance(item, str) and "=" in item:
                key = item.split("=", 1)[0].strip().lower()
                if key in BLOCKED_NESTED_KEYS:
                    raise InvalidOperationError(
                        f"Operation '{cmd_name}' at index {op_index}: "
                        f"nested key '{key}' is blocked (potential filesystem/network reference)"
                    )
