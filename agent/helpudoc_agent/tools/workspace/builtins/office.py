"""Model-facing, workspace-bound OfficeCLI mutation tool."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

from langchain_core.tools import Tool, tool
from pydantic import BaseModel, ConfigDict, Field

from ....state import WorkspaceState
from ..office.config import OfficeRunnerConfig
from ..office.runner import OfficeCLIOutputError, execute_batch, is_binary_ready
from ..office.security import (
    InvalidOperationError,
    PathTraversalError,
    resolve_workspace_path,
    validate_extension,
    validate_operations,
)

logger = logging.getLogger(__name__)

DOCUMENT_EXECUTE_ERROR_UNAVAILABLE = "OFFICECLI_UNAVAILABLE"
DOCUMENT_EXECUTE_ERROR_INVALID_REQUEST = "INVALID_DOCUMENT_REQUEST"
DOCUMENT_EXECUTE_ERROR_PATH = "PATH_OUTSIDE_WORKSPACE"
DOCUMENT_EXECUTE_ERROR_SOURCE = "SOURCE_NOT_FOUND"
DOCUMENT_EXECUTE_ERROR_TIMEOUT = "OFFICECLI_TIMEOUT"
DOCUMENT_EXECUTE_ERROR_OUTPUT = "OFFICECLI_OUTPUT_ERROR"
DOCUMENT_EXECUTE_ERROR_EXECUTION = "OFFICECLI_EXECUTION_FAILED"

_MODEL_COMMANDS = frozenset({"add", "set", "get", "query", "remove", "move", "swap", "view"})
_OFFICECLI_SEMAPHORE = asyncio.Semaphore(1)


class DocumentExecuteInput(BaseModel):
    """The deliberately small model-facing document mutation contract."""

    source_path: Optional[str] = Field(
        default=None,
        description="Existing workspace-relative DOCX, XLSX, or PPTX path.",
    )
    output_path: str = Field(
        ...,
        min_length=1,
        description="Workspace-relative output path using the same Office format as the source.",
    )
    operations: list[dict[str, Any]] = Field(
        ...,
        min_length=1,
        max_length=50,
        description=(
            "One to 50 ordered OfficeCLI operations. Every object has exactly one command. "
            "Allowed command fields are: add(path|parent,type,props,after,before,index); "
            "set(path,props); get(path,depth); query(selector,path,text); "
            "remove(path,props); move(path,to,after,before,index,props); "
            "swap(path,path2,to); view(mode). Use only the fields needed by that command. "
            "props may be an object or key=value strings, but nested filesystem/network keys "
            "such as src, file, path, url, uri, href, and fallback are rejected."
        ),
    )
    create_if_missing: bool = Field(
        default=False,
        description="Create a blank Office artifact when no source exists.",
    )

    model_config = ConfigDict(extra="forbid")


def _error(code: str, message: str, *, retryable: bool = False) -> str:
    return json.dumps(
        {"status": "error", "errorCode": code, "message": message, "retryable": retryable},
        ensure_ascii=False,
    )


def _workspace_parent_and_id(workspace_state: WorkspaceState) -> tuple[Path, str]:
    root = workspace_state.root_path.resolve(strict=False)
    return root.parent, root.name


def build_document_execute_tool(workspace_state: WorkspaceState) -> Tool:
    """Build one direct OfficeCLI tool bound to a trusted WorkspaceState."""

    config = OfficeRunnerConfig()

    @tool(args_schema=DocumentExecuteInput)
    async def document_execute(
        output_path: str,
        operations: list[dict[str, Any]],
        source_path: Optional[str] = None,
        create_if_missing: bool = False,
    ) -> str:
        """Atomically create or edit a DOCX, XLSX, or PPTX with typed OfficeCLI operations."""
        request_id = uuid4().hex
        request_bytes = len(
            json.dumps(
                {
                    "source_path": source_path,
                    "output_path": output_path,
                    "operations": operations,
                    "create_if_missing": create_if_missing,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        )
        if request_bytes > config.max_request_bytes:
            return _error(
                DOCUMENT_EXECUTE_ERROR_INVALID_REQUEST,
                f"Document request exceeds {config.max_request_bytes} bytes",
            )
        if not await asyncio.to_thread(is_binary_ready, config):
            return _error(
                DOCUMENT_EXECUTE_ERROR_UNAVAILABLE,
                "The pinned OfficeCLI binary is missing, incompatible, or failed integrity verification.",
            )

        try:
            for index, operation in enumerate(operations):
                command = operation.get("command") or operation.get("op")
                if command not in _MODEL_COMMANDS:
                    raise InvalidOperationError(
                        f"Command '{command}' at index {index} is not model-callable. "
                        f"Allowed: {sorted(_MODEL_COMMANDS)}"
                    )
            validate_operations(operations, config.max_operations)
            validate_extension(output_path, context="output_path")
            if source_path:
                validate_extension(source_path, context="source_path")
                if Path(source_path).suffix.lower() != Path(output_path).suffix.lower():
                    raise InvalidOperationError(
                        "source_path and output_path must use the same Office format"
                    )

            workspace_parent, workspace_id = _workspace_parent_and_id(workspace_state)
            workspace_base = workspace_state.root_path.resolve(strict=False)
            output_resolved = resolve_workspace_path(
                str(workspace_parent), workspace_id, output_path
            )
            source_resolved = None
            if source_path:
                source_resolved = resolve_workspace_path(
                    str(workspace_parent), workspace_id, source_path
                )
            elif output_resolved.exists():
                source_resolved = output_resolved

            response = await execute_batch(
                config=config,
                semaphore=_OFFICECLI_SEMAPHORE,
                workspace_base=workspace_base,
                source_resolved=source_resolved,
                output_resolved=output_resolved,
                operations=operations,
                create_if_missing=create_if_missing,
            )
        except (InvalidOperationError, ValueError) as exc:
            return _error(DOCUMENT_EXECUTE_ERROR_INVALID_REQUEST, str(exc))
        except PathTraversalError as exc:
            return _error(DOCUMENT_EXECUTE_ERROR_PATH, str(exc))
        except FileNotFoundError as exc:
            return _error(DOCUMENT_EXECUTE_ERROR_SOURCE, str(exc))
        except asyncio.TimeoutError:
            return _error(
                DOCUMENT_EXECUTE_ERROR_TIMEOUT,
                f"OfficeCLI did not complete within {config.timeout_seconds} seconds",
                retryable=True,
            )
        except OfficeCLIOutputError as exc:
            return _error(DOCUMENT_EXECUTE_ERROR_OUTPUT, str(exc))
        except Exception as exc:
            logger.exception("document_execute failed", extra={"request_id": request_id})
            return _error(DOCUMENT_EXECUTE_ERROR_EXECUTION, f"{type(exc).__name__}: {exc}")

        payload = response.model_dump(mode="json", by_alias=True)
        payload.update({"status": "ok" if response.success else "error", "request_id": request_id})
        if response.published:
            payload["output_path"] = output_path
        logger.info(
            "document_execute completed",
            extra={
                "request_id": request_id,
                "format": Path(output_path).suffix.lower(),
                "operation_count": len(operations),
                "operation_names": [op.get("command") or op.get("op") for op in operations],
                "duration_ms": response.duration_ms,
                "officecli_version": response.officecli_version,
                "published": response.published,
                "success": response.success,
                "request_bytes": request_bytes,
                "output_bytes": output_resolved.stat().st_size
                if response.published and output_resolved.is_file()
                else 0,
                "warning_count": len(response.warnings),
            },
        )
        return json.dumps(payload, ensure_ascii=False)

    document_execute.name = "document_execute"
    document_execute.description = (
        "Atomically create or edit a workspace DOCX, XLSX, or PPTX through pinned OfficeCLI. "
        "Pass only workspace-relative paths and use the operations schema as the command/field catalogue; workspace identity, validation, "
        "atomic publication, and execution limits are enforced by the host."
    )
    return document_execute
