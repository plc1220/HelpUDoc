"""Agent listing and chat/stream endpoints."""
from __future__ import annotations

import asyncio
import fnmatch
import inspect
import json
import logging
import os
import re
import sys
from typing import Any, AsyncGenerator, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple
from pathlib import Path
from uuid import uuid4
from datetime import datetime

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from langchain_core.callbacks.base import AsyncCallbackHandler
from langgraph.errors import GraphInterrupt, GraphRecursionError
from langgraph.types import Command

from helpudoc_agent.configuration import Settings
from helpudoc_agent.document_tool_guard import (
    LOOP_BREAK_ERROR_CODE,
    reset_document_tool_run_state,
)
from helpudoc_agent.interaction_contract import (
    interaction_interrupt_value_for_gate,
    next_pending_gate,
    record_gate_source,
)
from helpudoc_agent.interrupt_payloads import (
    extract_interrupt_payload_from_tool_args,
    extract_interrupt_payload_from_tool_call,
    extract_interrupt_payload_from_tool_text,
    normalize_interrupt_payload_value,
    strip_interrupt_payload_marker,
)
from helpudoc_agent.langfuse_callbacks import (
    emit_langfuse_trace_payload,
    langfuse_langchain_callbacks,
    patch_current_trace_skill,
)
from helpudoc_agent.memory_store import MemoryStoreManager
from helpudoc_agent.mcp_manager import describe_mcp_servers
from helpudoc_agent.plan_gates import (
    has_approved_plan_decision,
    has_edited_plan_decision,
    has_rejected_plan_decision,
    prepare_plan_context_for_explicit_resume,
    requested_dashboard_filters,
    requested_dashboard_output_path,
    requested_dashboard_time_field,
    requested_dashboard_title,
)
from helpudoc_agent.runtime.agent_registry import AgentRegistry
from helpudoc_agent.skills_registry import (
    activate_skill_context,
    build_loaded_skill_text,
    collect_tool_names,
    find_skill_for_context,
    is_skill_allowed,
    load_skills,
    read_helpudoc_learnings,
    read_skill_content,
)
from helpudoc_agent.state import AgentRuntimeState
from helpudoc_agent.tools_and_schemas import GeminiClientManager
from helpudoc_agent.utils import SourceTracker

from ..auth_context import extract_agent_request_context
from ..constants import (
    _ASSISTANT_ROLES,
    _INTERNAL_STREAM_TEXT_PATTERNS,
    _INTERRUPT_TOOL_NAMES,
    _TOOL_ROLES,
    _TAGGED_HTML_EXTENSIONS,
)
from ..directives import _extract_directive_from_text
from ..message_utils import (
    _copy_content_block,
    _extract_text_from_content,
    _inject_host_datetime_context,
    _message_to_text,
    _replace_content_text,
)
from ..schemas import (
    ChatRequest,
    ChatResponse,
    InterruptActionRequest,
    InterruptResponseRequest,
    ResumeChatRequest,
)
from ..tagged_context import (
    _append_tagged_file_guidance,
    _build_dashboard_mode_context,
    _build_dashboard_runtime_guidance,
    _extract_html_outline_from_path,
    _extract_tagged_files_from_text,
)
from ..text_utils import (
    _format_exception,
    _safe_langfuse_tag,
    _skill_id_from_loaded_skill_output,
    _clean_langfuse_value,
)
from ..tool_output import _extract_output_files_from_tool_result
 
def _friendly_tool_label(name: str) -> str:
    mapping = {
        "list_skills": "Checking available skills",
        "load_skill": "Loading the selected skill",
        "google_search": "Searching the web",
        "url_context": "Reading the provided link",
        "run_sql_query": "Querying the database",
        "write_file": "Writing a workspace file",
        "edit_file": "Updating a workspace file",
        "request_plan_approval": "Preparing approval request",
        "request_clarification": "Preparing a question for you",
        "workflow_action": "Preparing the next workflow step",
    }
    return mapping.get(name, f"Using {name.replace('_', ' ')}")


def _configured_recursion_limit(settings: Any) -> int:
    backend = getattr(settings, "backend", None)
    raw_value = getattr(backend, "recursion_limit", None)
    try:
        limit = int(raw_value)
    except (TypeError, ValueError):
        return 1000
    return limit if limit >= 1 else 1000


def _json_status_error(text: str) -> Optional[dict[str, Any]]:
    """Return the parsed envelope when a tool result is a JSON error envelope."""
    stripped = str(text or "").strip()
    if not stripped.startswith("{") or '"status"' not in stripped:
        return None
    try:
        parsed = json.loads(stripped)
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    if str(parsed.get("status") or "").strip().lower() != "error":
        return None
    return parsed


def _is_terminal_tool_failure(name: str, text: str) -> bool:
    normalized_name = str(name or "").strip().lower()
    normalized_text = str(text or "").strip().lower()
    envelope = _json_status_error(text)
    if envelope is not None:
        # Structured tool envelopes are terminal unless the tool says the call
        # can be retried as-is. LOOP_BREAK is always terminal.
        if envelope.get("errorCode") == LOOP_BREAK_ERROR_CODE:
            return True
        return envelope.get("retryable") is not True
    if normalized_name == "google_search":
        return (
            normalized_text.startswith('{"ok": false')
            or normalized_text.startswith("{'ok': false")
            or "google search timed out" in normalized_text
            or "search failed" in normalized_text
        )
    return False


async def _emit_progress(
    handler,
    phase: str,
    label: str,
    *,
    detail: str | None = None,
    status: str = "running",
    step_index: int | None = None,
    step_count: int | None = None,
    tool_name: str | None = None,
    artifact_path: str | None = None,
) -> None:
    payload = {
        "type": "progress",
        "phase": phase,
        "label": label,
        "status": status,
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }
    if detail is not None:
        payload["detail"] = detail
    if step_index is not None:
        payload["stepIndex"] = step_index
    if step_count is not None:
        payload["stepCount"] = step_count
    if tool_name is not None:
        payload["toolName"] = tool_name
    if artifact_path is not None:
        payload["artifactPath"] = artifact_path
    await handler._emit(payload)

logger = logging.getLogger(__name__)


def _has_usable_model_message(message: Any) -> bool:
    if not isinstance(message, dict):
        return False
    role = str(message.get("role") or "").strip()
    if not role:
        return False
    content = message.get("content")
    if isinstance(content, str):
        if content.strip():
            return True
    elif isinstance(content, list):
        if any(
            (isinstance(item, str) and item.strip())
            or (isinstance(item, dict) and bool(item))
            for item in content
        ):
            return True
    elif content is not None and str(content).strip():
        return True
    return bool(message.get("tool_calls") or message.get("function_call"))


def _validated_fresh_stream_input(
    payload: List[Dict[str, Any]],
    fallback_message: str = "",
) -> Dict[str, List[Dict[str, Any]]]:
    messages = [dict(item) for item in payload if _has_usable_model_message(item)]
    has_user_message = any(
        str(item.get("role") or "").strip().lower() in {"user", "human"}
        for item in messages
    )
    if not has_user_message and fallback_message.strip():
        messages.append({"role": "user", "content": fallback_message.strip()})
    if not messages:
        raise ValueError(
            "Agent request contains no usable message contents. "
            "Synthetic interactions must resume with a fresh continuation prompt."
        )
    return {"messages": messages}


def register_chat_routes(
    app: FastAPI,
    *,
    settings: Settings,
    memory_store_manager: MemoryStoreManager,
    registry: AgentRegistry,
    gemini_manager: GeminiClientManager,
    source_tracker: SourceTracker,
    agent_jwt_secret: str,
) -> None:
    @app.get("/agents")
    def list_agents():
        skills = load_skills(settings.backend.skills_root) if settings.backend.skills_root else []
        tool_names = collect_tool_names(skills, plugins_root=settings.backend.plugins_root)
        if tool_names:
            tool_names = [name for name in tool_names if name in settings.tools]
        if not tool_names:
            tool_names = list(settings.tools.keys())
        else:
            for extra in ("list_skills", "load_skill", "request_interaction", "workflow_action"):
                if extra in settings.tools and extra not in tool_names:
                    tool_names.append(extra)
        return {
            "agents": [
                {
                    "name": "fast",
                    "displayName": "Fast",
                    "description": "General assistant optimized for speed (Gemini Flash).",
                    "tools": tool_names,
                    "subagents": [],
                },
                {
                    "name": "pro",
                    "displayName": "Pro",
                    "description": "General assistant optimized for quality (Gemini Pro).",
                    "tools": tool_names,
                    "subagents": [],
                },
                {
                    "name": "skill-builder",
                    "displayName": "Skill Builder",
                    "description": "Admin-oriented assistant for creating and updating skills with structured actions.",
                    "tools": tool_names,
                    "subagents": [],
                },
            ],
            "mcpServers": describe_mcp_servers(settings),
        }

    def _prepare_payload(message: ChatRequest) -> List[Dict[str, Any]]:
        payload: List[Dict[str, Any]] = []
        if message.history:
            for item in message.history:
                if isinstance(item, dict):
                    payload.append(dict(item))
                else:
                    payload.append({"role": "user", "content": str(item)})
        if message.messageContent:
            copied_blocks = [_copy_content_block(block) for block in message.messageContent]
            for index in range(len(payload) - 1, -1, -1):
                role = str(payload[index].get("role") or "").strip().lower()
                if role in {"user", "human"}:
                    payload[index]["content"] = copied_blocks
                    return payload
            payload.append({"role": "user", "content": copied_blocks})
            return payload
        if payload:
            return payload
        return [{"role": "user", "content": message.message}]

    def _build_preloaded_skill_prompt(
        runtime: AgentRuntimeState,
        skill_id: str,
        user_request: str,
    ) -> str:
        fallback_request = user_request.strip() or "Continue with the selected skill."
        skill = find_skill_for_context(settings.backend.skills_root, skill_id, runtime.workspace_state.context)
        if skill is None:
            return (
                f"The user explicitly selected skill '{skill_id}', but it was not found in the configured skills registry.\n\n"
                f"User request:\n{fallback_request}"
            )
        if not is_skill_allowed(skill, runtime.workspace_state.context):
            return (
                f"The user explicitly selected skill '{skill.skill_id}', but it is not allowed for this user.\n\n"
                f"User request:\n{fallback_request}"
            )
        try:
            content = read_skill_content(skill)
        except Exception as exc:
            return (
                f"The user explicitly selected skill '{skill_id}', but the skill could not be read: {exc}\n\n"
                f"User request:\n{fallback_request}"
            )
        learnings = read_helpudoc_learnings(skill)
        if learnings and learnings.strip():
            content = (
                f"{content.rstrip()}\n\n---\n\n## HelpUDoc approved learnings (docs/HELPUDOC_LEARNINGS.md)\n\n"
                f"{learnings.strip()}\n"
            )

        activate_skill_context(
            runtime.workspace_state.context,
            skill,
            plugins_root=getattr(settings.backend, "plugins_root", None),
        )
        dashboard_guidance = ""
        if skill.skill_id == "data/dashboard":
            dashboard_guidance = _build_dashboard_runtime_guidance(user_request)
        return "\n\n".join(
            [
                f"The selected skill '{skill.skill_id}' is already loaded and active for this turn.",
                "Do not call list_skills or load_skill again unless you need to switch to a different skill.",
                build_loaded_skill_text(skill, content),
                dashboard_guidance,
                f"User request:\n{fallback_request}",
            ]
        )

    def _build_preferred_mcp_prompt(server_id: str, user_request: str) -> str:
        normalized_server_id = str(server_id or "").strip()
        fallback_request = user_request.strip() or f"Use MCP server '{normalized_server_id}' for this task."
        return "\n\n".join(
            [
                f"The preferred MCP server for this turn is '{normalized_server_id}'.",
                "Prefer tools from that server before unrelated MCP servers or general web search when they can satisfy the request.",
                f"User request:\n{fallback_request}",
            ]
        )

    def _trace_skill_id(trace_context: Dict[str, Any] | None) -> str:
        trace = trace_context if isinstance(trace_context, dict) else {}
        return _clean_langfuse_value(trace.get("skillId")) or ""

    def _activate_skill_from_trace_context(context: Dict[str, Any], trace_context: Dict[str, Any] | None) -> None:
        skill_id = _trace_skill_id(trace_context)
        if not skill_id or context.get("active_skill"):
            return
        skill = find_skill_for_context(settings.backend.skills_root, skill_id, context)
        if skill is not None and is_skill_allowed(skill, context):
            context.pop("preferred_mcp_server", None)
            activate_skill_context(context, skill, plugins_root=getattr(settings.backend, "plugins_root", None))

    def _inject_trace_skill_prompt(
        runtime: AgentRuntimeState,
        payload: List[Dict[str, Any]],
        message: ChatRequest,
    ) -> tuple[List[Dict[str, Any]], str | None]:
        skill_id = _trace_skill_id(message.langfuseTraceContext)
        if not skill_id or runtime.workspace_state.context.get("active_skill"):
            return payload, None
        for index in range(len(payload) - 1, -1, -1):
            item = payload[index]
            role = str(item.get("role") or "").strip().lower()
            if role not in {"user", "human"}:
                continue
            content = item.get("content")
            user_text = _extract_text_from_content(content)
            item["content"] = _replace_content_text(
                content,
                _build_preloaded_skill_prompt(runtime, skill_id, user_text),
            )
            return payload, user_text
        return payload, None

    def _apply_embedded_directives(
        runtime: AgentRuntimeState,
        payload: List[Dict[str, Any]],
    ) -> Tuple[List[Dict[str, Any]], str]:
        latest_user_text = ""
        for index in range(len(payload) - 1, -1, -1):
            message = payload[index]
            role = str(message.get("role") or "").strip().lower()
            if role not in {"user", "human"}:
                continue
            content = message.get("content")
            latest_text = _extract_text_from_content(content)
            if not latest_text:
                break
            directive, stripped_text = _extract_directive_from_text(latest_text)
            latest_user_text = stripped_text
            if directive is None:
                message["content"] = _replace_content_text(content, stripped_text)
                break
            if directive.kind == "skill" and directive.skillId:
                runtime.workspace_state.context.pop("preferred_mcp_server", None)
                message["content"] = _replace_content_text(
                    content,
                    _build_preloaded_skill_prompt(runtime, directive.skillId, stripped_text),
                )
            elif directive.kind == "mcp" and directive.serverId:
                runtime.workspace_state.context["preferred_mcp_server"] = directive.serverId
                message["content"] = _replace_content_text(
                    content,
                    _build_preferred_mcp_prompt(directive.serverId, stripped_text),
                )
            else:
                message["content"] = _replace_content_text(content, stripped_text)
            break
        return payload, latest_user_text

    def _extract_request_context(request: Request) -> Dict[str, Any]:
        return extract_agent_request_context(request, agent_jwt_secret=agent_jwt_secret)

    def _merge_trace_gate_context(context: Dict[str, Any], trace_context: Dict[str, Any] | None) -> Dict[str, Any]:
        merged = dict(context or {})
        trace = trace_context if isinstance(trace_context, dict) else {}
        gate_state = trace.get("interactionGateState")
        completed_gates = gate_state.get("completedGateIds") if isinstance(gate_state, dict) else None
        if isinstance(completed_gates, list):
            normalized_gates = [
                str(item).strip()
                for item in completed_gates
                if str(item).strip()
            ]
            if normalized_gates:
                merged["frontend_slides_completed_interaction_gates"] = normalized_gates
                ledger = merged.get("interaction_gate_ledger")
                ledger_items = [item for item in ledger if isinstance(item, dict)] if isinstance(ledger, list) else []
                existing = {
                    (
                        str(item.get("run_id") or ""),
                        str(item.get("thread_id") or ""),
                        str(item.get("skill_id") or ""),
                        str(item.get("gate_id") or ""),
                    )
                    for item in ledger_items
                }
                now = datetime.utcnow().isoformat() + "Z"
                trace_run_id = _clean_langfuse_value(trace.get("runId")) or ""
                if trace_run_id:
                    merged.setdefault("run_id", trace_run_id)
                trace_thread_id = str(merged.get("thread_id") or "")
                for gate_id in normalized_gates:
                    key = (trace_run_id, trace_thread_id, "frontend-slides", gate_id)
                    if key in existing:
                        continue
                    ledger_items.append(
                        {
                            "run_id": trace_run_id,
                            "thread_id": trace_thread_id,
                            "skill_id": "frontend-slides",
                            "gate_id": gate_id,
                            "presentation": "",
                            "status": "completed",
                            "source": "direct",
                            "answers": None,
                            "created_at": now,
                            "updated_at": now,
                            "completed_at": now,
                            "violation_count": 0,
                        }
                    )
                merged["interaction_gate_ledger"] = ledger_items
        return merged

    def _memory_paths_for_turn(runtime: AgentRuntimeState) -> List[str]:
        context = runtime.workspace_state.context or {}
        user_id = context.get("user_id")
        if not isinstance(user_id, str) or not user_id.strip():
            return []
        workspace_id = runtime.workspace_state.workspace_id
        return [
            "/memories/global/preferences.md",
            "/memories/global/context.md",
            "/memories/global/skill-routing.md",
            f"/memories/workspaces/{workspace_id}/preferences.md",
            f"/memories/workspaces/{workspace_id}/context.md",
            f"/memories/workspaces/{workspace_id}/skill-routing.md",
        ]

    def _build_memory_system_message(runtime: AgentRuntimeState) -> str | None:
        context = runtime.workspace_state.context or {}
        user_id = context.get("user_id")
        if not isinstance(user_id, str) or not user_id.strip():
            return None
        paths = _memory_paths_for_turn(runtime)
        files = memory_store_manager.read_many(user_id.strip(), paths)
        existing_lines: List[str] = []
        digest_lines: List[str] = []
        char_budget = 3200
        used = 0
        for path in paths:
            file = files.get(path)
            if not file or not file.exists or not file.content.strip():
                continue
            existing_lines.append(f"- {path}")
            excerpt = file.content.strip()
            remaining = max(0, char_budget - used)
            if remaining <= 0:
                continue
            clipped = excerpt[:remaining]
            used += len(clipped)
            digest_lines.append(f"{path}:\n{clipped}")
        if not existing_lines:
            return None
        sections = [
            "Persistent memory is available for this user.",
            "Relevant memory files:",
            "\n".join(existing_lines),
            "Consult these files when they are relevant to the request. Treat them as approved long-term user memory.",
            "Do not modify any /memories/* file during normal chat runs.",
        ]
        if digest_lines:
            sections.extend(
                [
                    "Memory digest:",
                    "\n\n".join(digest_lines),
                ]
            )
        return "\n\n".join(section for section in sections if section)

    def _seed_initial_skill_context(initial_context: Dict[str, Any], message: ChatRequest) -> Dict[str, Any]:
        seeded = _merge_trace_gate_context(initial_context, message.langfuseTraceContext)
        seeded["internet_search_enabled"] = bool(message.internetSearchEnabled)
        seeded["knowledge_refs"] = [dict(item) for item in message.knowledgeRefs if isinstance(item, dict)]
        payload = _prepare_payload(message)
        saw_directive = False
        for index in range(len(payload) - 1, -1, -1):
            item = payload[index]
            role = str(item.get("role") or "").strip().lower()
            if role not in {"user", "human"}:
                continue
            content = item.get("content")
            directive, _ = _extract_directive_from_text(_extract_text_from_content(content))
            if directive is None:
                break
            saw_directive = True
            if directive.kind == "skill" and directive.skillId:
                skill = find_skill_for_context(
                    settings.backend.skills_root,
                    directive.skillId,
                    seeded,
                )
                if skill is not None and is_skill_allowed(skill, seeded):
                    seeded.pop("preferred_mcp_server", None)
                    activate_skill_context(seeded, skill, plugins_root=getattr(settings.backend, "plugins_root", None))
            elif directive.kind == "mcp" and directive.serverId:
                seeded["preferred_mcp_server"] = directive.serverId
            break
        if not saw_directive:
            _activate_skill_from_trace_context(seeded, message.langfuseTraceContext)
        return seeded


    def _extract_tagged_files(content: str) -> List[str]:
        return _extract_tagged_files_from_text(content)

    def _load_tagged_html_outline(workspace_id: str, tagged_paths: List[str]) -> str | None:
        workspace_root = Path(settings.backend.workspace_root).resolve() / workspace_id
        for raw in tagged_paths:
            if not raw:
                continue
            normalized = str(raw).strip().lstrip("/").replace("\\", "/")
            if Path(normalized).suffix.lower() not in _TAGGED_HTML_EXTENSIONS:
                continue
            candidate = (workspace_root / normalized).resolve()
            if workspace_root not in candidate.parents and candidate != workspace_root:
                continue
            if not candidate.exists() or not candidate.is_file():
                continue
            outline = _extract_html_outline_from_path(candidate)
            if outline:
                return outline
        return None

    def _get_thread_id(
        runtime: AgentRuntimeState,
        force_reset: bool,
        run_id: str = "",
        trace_thread_id: str = "",
    ) -> str:
        context = runtime.workspace_state.context
        run_id = str(run_id or "").strip()
        trace_thread_id = str(trace_thread_id or "").strip()
        # The backend-provided thread ID is authoritative. It is derived from
        # the durable run ID and must override any stale in-memory context
        # when a runtime is reused or recreated for a resume.
        if trace_thread_id:
            thread_id = trace_thread_id
        else:
            suffix = ""
            if isinstance(context, dict):
                user_id = context.get("user_id")
                if isinstance(user_id, str) and user_id.strip():
                    suffix = f":{user_id.strip()}"
            base = f"{runtime.agent_name}:{runtime.workspace_state.workspace_id}{suffix}"
            if force_reset:
                thread_id = f"{base}:{uuid4()}"
            elif run_id:
                # Resume requests may rebuild the runtime when MCP policy or
                # delegated auth changes. Bind the checkpoint to the durable
                # backend run id so the LangGraph interrupt can still resume.
                thread_id = f"{base}:run:{run_id}"
            elif context.get("thread_id"):
                thread_id = context["thread_id"]
            else:
                thread_id = base
        context["thread_id"] = thread_id
        return context["thread_id"]



    def _build_langfuse_metadata(
        runtime: AgentRuntimeState,
        message: ChatRequest,
        thread_id: str,
    ) -> Tuple[Dict[str, Any], List[str]]:
        context = getattr(runtime.workspace_state, "context", None)
        context = context if isinstance(context, dict) else {}
        trace_context = message.langfuseTraceContext if isinstance(message.langfuseTraceContext, dict) else {}
        user_id = (
            _clean_langfuse_value(trace_context.get("userId"))
            or _clean_langfuse_value(context.get("user_id"))
        )
        run_id = _clean_langfuse_value(trace_context.get("runId"))
        turn_id = _clean_langfuse_value(trace_context.get("turnId"))
        workspace_id = (
            _clean_langfuse_value(trace_context.get("workspaceId"))
            or _clean_langfuse_value(runtime.workspace_state.workspace_id)
        )
        persona = _clean_langfuse_value(trace_context.get("persona")) or _clean_langfuse_value(runtime.agent_name)
        conversation_id = _clean_langfuse_value(trace_context.get("conversationId"))
        skill_trace = _clean_langfuse_value(trace_context.get("skillId")) or _clean_langfuse_value(
            context.get("active_skill")
        )
        if not skill_trace:
            scope = context.get("active_skill_scope")
            if isinstance(scope, dict):
                skill_trace = _clean_langfuse_value(scope.get("skill_id")) or _clean_langfuse_value(
                    scope.get("id")
                )
        session_id = conversation_id or thread_id

        metadata: Dict[str, Any] = {
            "langfuse_session_id": session_id,
            "helpudoc_workspace_id": workspace_id,
            "helpudoc_agent": persona,
            "helpudoc_force_reset": bool(message.forceReset),
        }
        if user_id:
            metadata["langfuse_user_id"] = user_id
        if run_id:
            metadata["helpudoc_run_id"] = run_id
        if turn_id:
            metadata["helpudoc_turn_id"] = turn_id
        if conversation_id:
            metadata["helpudoc_conversation_id"] = conversation_id
        if skill_trace:
            metadata["helpudoc_skill_id"] = skill_trace
        active_version = context.get("active_skill_version")
        if isinstance(active_version, dict):
            if _clean_langfuse_value(active_version.get("version_id")):
                metadata["helpudoc_skill_version_id"] = active_version.get("version_id")
            if _clean_langfuse_value(active_version.get("semantic_version")):
                metadata["helpudoc_skill_semantic_version"] = active_version.get("semantic_version")
            if _clean_langfuse_value(active_version.get("manifest_hash")):
                metadata["helpudoc_skill_manifest_hash"] = active_version.get("manifest_hash")

        tags = [
            "helpudoc",
            _safe_langfuse_tag("workspace", workspace_id),
            _safe_langfuse_tag("agent", persona),
            _safe_langfuse_tag("environment", os.getenv("NODE_ENV") or os.getenv("ENV") or "development"),
        ]
        if conversation_id:
            tags.append(f"conversation:{conversation_id[:96]}")
        if skill_trace:
            tags.append(_safe_langfuse_tag("skill", skill_trace) or f"skill:{skill_trace[:96]}")
        if run_id:
            tags.append(_safe_langfuse_tag("run", run_id) or f"run:{run_id[:96]}")
        if message.forceReset:
            tags.append("force-reset")
        return metadata, [tag for tag in tags if tag]

    def _build_agent_config(runtime: AgentRuntimeState, message: ChatRequest, callbacks=None) -> Dict[str, Any]:
        trace_context = message.langfuseTraceContext if isinstance(message.langfuseTraceContext, dict) else {}
        run_id = _clean_langfuse_value(trace_context.get("runId"))
        trace_thread_id = _clean_langfuse_value(trace_context.get("threadId"))
        thread_id = _get_thread_id(runtime, message.forceReset, run_id, trace_thread_id)
        runtime_context = runtime.workspace_state.context or {}
        configurable: Dict[str, Any] = {"thread_id": thread_id}
        user_id = runtime_context.get("user_id")
        if isinstance(user_id, str) and user_id.strip():
            configurable["user_id"] = user_id.strip()
        workspace_id = runtime_context.get("workspace_id") or runtime.workspace_state.workspace_id
        if isinstance(workspace_id, str) and workspace_id.strip():
            configurable["workspace_id"] = workspace_id.strip()
        metadata, tags = _build_langfuse_metadata(runtime, message, thread_id)
        runtime_context["thread_id"] = thread_id
        if metadata.get("helpudoc_run_id"):
            runtime_context["run_id"] = metadata["helpudoc_run_id"]
        trace_name = f"helpudoc.{runtime.agent_name}"
        config: Dict[str, Any] = {
            "configurable": configurable,
            "metadata": metadata,
            "tags": tags,
            "run_name": trace_name,
        }
        if callbacks:
            config["callbacks"] = callbacks
        return config

    async def _invoke_agent(runtime: AgentRuntimeState, message: ChatRequest):
        agent = getattr(runtime, "agent", None)
        if agent is None:
            raise HTTPException(status_code=500, detail="Agent not initialized")
        context = getattr(runtime.workspace_state, "context", None)
        manager = context.get("data_agent_manager") if isinstance(context, dict) else None
        if manager and hasattr(manager, "reset_session"):
            manager.reset_session()
        payload = await _prepare_turn_payload(runtime, message, fresh_turn=True)
        lf = langfuse_langchain_callbacks()
        config = _build_agent_config(runtime, message, callbacks=lf or None)
        if hasattr(agent, "ainvoke"):
            return await agent.ainvoke({"messages": payload}, config=config, context=runtime.workspace_state.context)
        return agent.invoke({"messages": payload}, config=config, context=runtime.workspace_state.context)

    def _json_line(payload: Dict[str, Any]) -> bytes:
        return (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")

    class _CallbackStreamingHandler(AsyncCallbackHandler):
        """Streams LangChain callback events into JSON payloads for the UI."""

        def __init__(
            self,
            text_fn,
            *,
            suppress_interrupt_tool_start: bool = False,
            should_suppress_assistant_text: Callable[[], bool] | None = None,
        ):
            super().__init__()
            self.queue: asyncio.Queue[Any] = asyncio.Queue()
            self._tool_names: Dict[str, str] = {}
            self._tool_meta: Dict[str, Any] = {}
            self._active_llm_runs: Set[str] = set()
            self._reported_llm_runs: Set[str] = set()
            self._to_text = text_fn
            self._has_events = False
            self._has_assistant_text = False
            self._interrupt_emitted = False
            self._resume_interrupt_consumed = False
            self._pending_interrupt_payload: Dict[str, Any] | None = None
            self._native_dashboard_builder_calls = 0
            self._native_dashboard_builder_run_keys: Set[str] = set()
            self._v3_text_blocks: Dict[Tuple[str, str], str] = {}
            self._cancel_run: Optional[Callable[[], None]] = None
            self._suppress_interrupt_tool_start = suppress_interrupt_tool_start
            self._should_suppress_assistant_text = should_suppress_assistant_text

        @property
        def has_events(self) -> bool:
            return self._has_events

        @property
        def has_assistant_text(self) -> bool:
            return self._has_assistant_text

        @property
        def interrupt_emitted(self) -> bool:
            return self._interrupt_emitted

        @property
        def resume_interrupt_consumed(self) -> bool:
            return self._resume_interrupt_consumed

        def queue_pending_interrupt(self, payload: Dict[str, Any]) -> None:
            # Callback events can arrive before LangGraph has committed the
            # interrupt checkpoint. Keep the payload local until the graph
            # event stream has drained; exposing it earlier lets the backend
            # close the HTTP stream before the checkpoint is resumable.
            self._pending_interrupt_payload = payload

        def take_pending_interrupt(self) -> Dict[str, Any] | None:
            payload = self._pending_interrupt_payload
            self._pending_interrupt_payload = None
            return payload

        @property
        def native_dashboard_builder_calls(self) -> int:
            return self._native_dashboard_builder_calls

        def record_tool_start(self, name: str, preview: str, run_key: str = "") -> None:
            if (
                name == "run_skill_python_script"
                and "build_native_dashboard_package" in preview
            ):
                normalized_key = str(run_key or "").strip()
                if normalized_key and normalized_key in self._native_dashboard_builder_run_keys:
                    return
                if normalized_key:
                    self._native_dashboard_builder_run_keys.add(normalized_key)
                self._native_dashboard_builder_calls += 1

        def attach_cancel(self, cancel_cb: Callable[[], None]) -> None:
            self._cancel_run = cancel_cb

        async def _emit(self, payload: Dict[str, Any]) -> None:
            if payload.get("type") in {"token", "chunk"}:
                role = payload.get("role")
                if role is None or str(role).lower() == "assistant":
                    if self._should_suppress_assistant_text and self._should_suppress_assistant_text():
                        return
                    self._has_assistant_text = True
            self._has_events = True
            await self.queue.put(payload)

        async def _emit_model_start(self, serialized: Any, run_id: Any) -> None:
            run_key = str(run_id)
            if run_key in self._reported_llm_runs:
                return
            self._reported_llm_runs.add(run_key)
            name = ""
            if isinstance(serialized, dict):
                name = str(serialized.get("name") or serialized.get("id") or "").strip()
            await _emit_progress(
                self,
                "preparing_context",
                "Workspace context is ready",
                status="completed",
            )
            await _emit_progress(self, "planning", "Thinking through the next step")
            await self._emit({"type": "model_start", "name": name or "model"})

        async def on_llm_start(self, serialized, prompts, *, run_id, **_: Any) -> None:
            await self._emit_model_start(serialized, run_id)

        async def on_chat_model_start(self, serialized, messages, *, run_id, **_: Any) -> None:
            await self._emit_model_start(serialized, run_id)

        async def on_llm_new_token(
            self,
            token: str,
            *,
            run_id,
            **_: Any,
        ) -> None:
            if not token:
                return
            token = strip_interrupt_payload_marker(token)
            if not token:
                return
            self._active_llm_runs.add(str(run_id))
            await self._emit({"type": "token", "content": token, "role": "assistant"})

        async def on_llm_end(self, response, *, run_id, **_: Any) -> None:
            await self._emit({"type": "model_end", "name": "model"})
            run_key = str(run_id)
            if run_key in self._active_llm_runs:
                self._active_llm_runs.discard(run_key)
                return
            generations = getattr(response, "generations", None)
            if not generations:
                return
            text_parts: List[str] = []
            for generation in generations:
                if not generation:
                    continue
                candidate = generation[0]
                candidate_text = getattr(candidate, "text", None)
                if candidate_text:
                    text_parts.append(candidate_text)
            if text_parts:
                await self._emit(
                    {"type": "token", "content": "".join(text_parts), "role": "assistant"}
                )

        async def on_agent_action(self, action, **_: Any) -> None:
            log = getattr(action, "log", "")
            if log:
                await self._emit({"type": "thought", "content": log})

        async def on_agent_finish(self, finish, **_: Any) -> None:
            if self._has_assistant_text:
                return
            text = ""
            return_values = getattr(finish, "return_values", None)
            if isinstance(return_values, dict):
                candidate = return_values.get("output") or return_values.get("text")
                if isinstance(candidate, str):
                    text = candidate
            if not text:
                text = self._to_text(finish)
            if text:
                for piece in _chunk_text(text):
                    await self._emit({"type": "token", "content": piece, "role": "assistant"})

        async def on_tool_start(
            self,
            serialized,
            input_str,
            *,
            run_id,
            metadata: Dict[str, Any] | None = None,
            **_: Any,
        ) -> None:
            name = (serialized or {}).get("name") or (metadata or {}).get("name") or "tool"
            self._tool_names[str(run_id)] = name
            preview = input_str.strip()
            self.record_tool_start(name, preview, str(run_id))
            if name in _INTERRUPT_TOOL_NAMES:
                # Do not expose the form from tool-call arguments. The tool must
                # reach LangGraph's interrupt() first so a resumable checkpoint
                # exists before the UI accepts a human response.
                return
            await _emit_progress(
                self,
                "using_tool",
                _friendly_tool_label(name),
                detail=name,
                tool_name=name,
            )
            await self._emit(
                {
                    "type": "tool_start",
                    "name": name,
                    "content": preview[:200] if preview else "",
                }
            )

        async def on_tool_end(self, output, *, run_id, **_: Any) -> None:
            run_key = str(run_id)
            name = self._tool_names.pop(run_key, "tool")
            text = self._to_text(output)
            if name in _INTERRUPT_TOOL_NAMES:
                interrupt_payload = extract_interrupt_payload_from_tool_text(text)
                if interrupt_payload:
                    self._tool_meta.pop(run_key, None)
                    self.queue_pending_interrupt(interrupt_payload)
                    return
                # The interrupted tool returned a normal value, which proves the
                # resume payload was applied. Stale checkpoint interrupt events
                # may precede this callback and must not end the resumed stream.
                self._resume_interrupt_consumed = True
            tool_failed = _is_terminal_tool_failure(name, text)
            await _emit_progress(
                self,
                "using_tool",
                (
                    f"{_friendly_tool_label(name)} hit a timeout"
                    if tool_failed and name == "google_search" and "timed out" in text.lower()
                    else f"{_friendly_tool_label(name)} failed"
                    if tool_failed
                    else f"Finished {_friendly_tool_label(name)}"
                ),
                detail=("The agent will continue without retrying this tool." if tool_failed else name),
                tool_name=name,
                status="error" if tool_failed else "completed",
            )
            payload: Dict[str, Any] = {
                "type": "tool_error" if tool_failed else "tool_end",
                "name": name,
                "content": text,
            }
            output_files = _extract_output_files_from_tool_result(name, text)
            meta = self._tool_meta.pop(run_key, None)
            if meta and meta.get("files"):
                output_files.extend(meta["files"])
            if output_files:
                dedup: Dict[str, Dict[str, Any]] = {}
                for item in output_files:
                    path = str(item.get("path") or "").strip()
                    if not path:
                        continue
                    dedup[path] = item
                payload["outputFiles"] = list(dedup.values())
            if name == "load_skill":
                loaded_skill_id = _skill_id_from_loaded_skill_output(text)
                if loaded_skill_id:
                    patch_current_trace_skill(loaded_skill_id)
            if meta and meta.get("dashboardArtifact"):
                payload["dashboardArtifact"] = meta["dashboardArtifact"]
            await self._emit(payload)

        async def on_tool_error(self, error, *, run_id, **_: Any) -> None:
            run_key = str(run_id)
            name = self._tool_names.pop(run_key, "tool")
            if _extract_interrupt_from_exception(error):
                self._tool_meta.pop(run_key, None)
                return
            await self._emit(
                {
                    "type": "tool_error",
                    "name": name,
                    "content": _format_exception(error),
                }
            )

        async def on_custom_event(
            self,
            name: str,
            data: Any,
            *,
            run_id,
            **_: Any,
        ) -> None:
            run_key = str(run_id)
            if name == "tool_artifacts" and isinstance(data, dict):
                bucket = self._tool_meta.get(run_key) or {}
                bucket["files"] = list(data.get("files") or [])
                self._tool_meta[run_key] = bucket
                return
            if name == "dashboard_artifact" and isinstance(data, dict):
                bucket = self._tool_meta.get(run_key) or {}
                bucket["dashboardArtifact"] = data
                self._tool_meta[run_key] = bucket
                await self._emit({"type": "dashboard_artifact", "dashboardArtifact": data})

    class _DeltaTracker:
        def __init__(self) -> None:
            self._latest: Dict[str, str] = {}

        def push(self, role: str, text: str) -> str:
            if not text:
                return ""
            previous = self._latest.get(role, "")
            if text.startswith(previous):
                delta = text[len(previous):]
            else:
                delta = text
            self._latest[role] = text
            return delta

    def _chunk_text(payload: str, max_chars: int = 60) -> Iterable[str]:
        if len(payload) <= max_chars:
            return [payload]

        chunks: List[str] = []
        start = 0
        text_length = len(payload)
        while start < text_length:
            end = min(text_length, start + max_chars)
            if end < text_length:
                newline = payload.rfind("\n", start, end)
                if newline > start + 40:
                    end = newline + 1
            chunk = payload[start:end]
            if chunk:
                chunks.append(chunk)
            start = max(end, start + 1)
        return chunks



    def _is_internal_stream_text(text: str) -> bool:
        normalized = (text or "").strip()
        if not normalized:
            return False
        return any(pattern.match(normalized) for pattern in _INTERNAL_STREAM_TEXT_PATTERNS)

    def _message_role(message: Any) -> str:
        for attr in ("type", "role"):
            value = getattr(message, attr, None)
            if isinstance(value, str):
                return value.lower()
            if isinstance(value, dict):
                role = value.get("role")
                if isinstance(role, str):
                    return role.lower()
        if isinstance(message, dict):
            role = message.get("role")
            if isinstance(role, str):
                return role.lower()
        return "assistant"

    def _parse_multi_mode_chunk(raw_chunk: Any) -> tuple[str | None, Any]:
        if isinstance(raw_chunk, tuple) and len(raw_chunk) == 2 and isinstance(raw_chunk[0], str):
            return raw_chunk[0], raw_chunk[1]
        if isinstance(raw_chunk, dict) and isinstance(raw_chunk.get("type"), str) and "data" in raw_chunk:
            return raw_chunk.get("type"), raw_chunk.get("data")
        return None, raw_chunk

    def _extract_messages(chunk: Any) -> List[Any] | None:
        if chunk is None:
            return None
        mode, parsed_chunk = _parse_multi_mode_chunk(chunk)
        if mode == "updates":
            chunk = parsed_chunk
        elif mode == "messages":
            if isinstance(parsed_chunk, (list, tuple)) and parsed_chunk:
                return [parsed_chunk[0]]
            if parsed_chunk is not None:
                return [parsed_chunk]
            return None
        if isinstance(chunk, dict):
            if "messages" in chunk:
                return chunk.get("messages")  # type: ignore[return-value]
            output = chunk.get("output")
            if isinstance(output, dict) and "messages" in output:
                return output.get("messages")  # type: ignore[return-value]
        if isinstance(chunk, (list, tuple)):
            if len(chunk) == 2 and chunk[0] == "messages":
                candidate = chunk[1]
                if isinstance(candidate, (list, tuple)):
                    return list(candidate)
                if candidate is not None:
                    return [candidate]
                return None
            for item in chunk:
                if isinstance(item, dict) and "messages" in item:
                    return item.get("messages")  # type: ignore[return-value]
        return None

    def _build_interrupt_payload(raw: Any) -> Dict[str, Any] | None:
        if not raw or not isinstance(raw, (list, tuple)):
            return None
        first = raw[0] if raw else None
        if first is None:
            return None

        interrupt_value = None
        interrupt_id = None
        if isinstance(first, dict):
            interrupt_value = first.get("value")
            interrupt_id = first.get("id")
        else:
            interrupt_value = getattr(first, "value", None)
            interrupt_id = getattr(first, "id", None)

        if not isinstance(interrupt_value, dict):
            return None

        return normalize_interrupt_payload_value(interrupt_value, interrupt_id if isinstance(interrupt_id, str) else None)

    def _extract_interrupt_payload(chunk: Any) -> Dict[str, Any] | None:
        mode, parsed_chunk = _parse_multi_mode_chunk(chunk)
        if mode == "updates":
            chunk = parsed_chunk
        elif mode == "messages":
            return None
        if not isinstance(chunk, dict):
            return None
        payload = _build_interrupt_payload(chunk.get("__interrupt__"))
        if payload:
            return payload
        messages = _extract_messages(chunk)
        if messages:
            for msg in reversed(messages):
                text = _message_to_text(msg)
                payload = extract_interrupt_payload_from_tool_text(text)
                if payload:
                    return payload
        return None

    def _event_record(event: Any) -> Dict[str, Any] | None:
        if isinstance(event, dict):
            return event
        if isinstance(event, (list, tuple)) and event and isinstance(event[0], dict):
            return event[0]
        return None

    def _event_raw_data(event: Any) -> Any:
        event = _event_record(event)
        if not isinstance(event, dict):
            return None
        if "data" in event:
            return event.get("data")
        params = event.get("params")
        if isinstance(params, dict):
            return params.get("data")
        return None

    def _unwrap_v3_event_data(data: Any) -> Any:
        if isinstance(data, (list, tuple)) and data and isinstance(data[0], dict):
            return data[0]
        return data

    def _v3_event_metadata(data: Any) -> Dict[str, Any]:
        if (
            isinstance(data, (list, tuple))
            and len(data) >= 2
            and isinstance(data[1], dict)
        ):
            return data[1]
        return {}

    def _event_method(event: Any) -> str:
        event = _event_record(event)
        if not isinstance(event, dict):
            return ""
        method = event.get("event") or event.get("method") or event.get("type")
        raw_data = _event_raw_data(event)
        inner = _unwrap_v3_event_data(raw_data)
        if str(method or "").strip() in {"messages", "tools"} and isinstance(inner, dict):
            inner_method = inner.get("event")
            if isinstance(inner_method, str) and inner_method.strip():
                return inner_method.strip()
        return str(method or "").strip()

    def _event_data(event: Any) -> Any:
        return _unwrap_v3_event_data(_event_raw_data(event))

    def _event_name(event: Any) -> str:
        event = _event_record(event)
        if not isinstance(event, dict):
            return ""
        name = event.get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()
        data = _event_data(event)
        if isinstance(data, dict):
            candidate = data.get("name") or data.get("tool_name")
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
            content = data.get("content")
            if isinstance(content, dict):
                candidate = content.get("name")
                if isinstance(candidate, str) and candidate.strip():
                    return candidate.strip()
        params = event.get("params")
        if isinstance(params, dict):
            namespace = params.get("namespace")
            if isinstance(namespace, list) and namespace:
                tail = str(namespace[-1] or "")
                return tail.split(":", 1)[0].strip()
        return ""

    def _event_run_id(event: Any) -> str:
        event = _event_record(event)
        if not isinstance(event, dict):
            return ""
        run_id = event.get("run_id") or event.get("runId")
        if run_id:
            return str(run_id)
        raw_data = _event_raw_data(event)
        metadata = _v3_event_metadata(raw_data)
        if metadata:
            candidate = metadata.get("run_id") or metadata.get("runId")
            if candidate:
                return str(candidate)
        params = event.get("params")
        if isinstance(params, dict):
            data = _event_data(event)
            if isinstance(data, dict):
                candidate = (
                    data.get("run_id")
                    or data.get("runId")
                    or data.get("tool_call_id")
                    or data.get("id")
                )
                if not candidate:
                    content = data.get("content")
                    if isinstance(content, dict):
                        candidate = content.get("id")
                if candidate:
                    return str(candidate)
            namespace = params.get("namespace")
            if isinstance(namespace, list) and namespace:
                return str(namespace[-1])
        return ""

    def _event_text(value: Any, *, stringify_objects: bool = False) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        if isinstance(value, (int, float, bool)):
            return str(value)
        if isinstance(value, (list, tuple)):
            if len(value) == 2 and isinstance(value[1], dict):
                candidate = value[0]
                role = _message_role(candidate)
                if role not in _ASSISTANT_ROLES:
                    return ""
                return _event_text(candidate, stringify_objects=stringify_objects)
            return "".join(_event_text(item, stringify_objects=stringify_objects) for item in value)
        if isinstance(value, dict):
            for key in ("text", "content", "message", "output", "chunk"):
                if key in value:
                    text = _event_text(value.get(key), stringify_objects=stringify_objects)
                    if text:
                        return text
            return json.dumps(value, ensure_ascii=False) if stringify_objects else ""
        text = _message_to_text(value)
        if text and not re.match(r"^[A-Za-z]+Message", text):
            return text
        return json.dumps(value, ensure_ascii=False, default=str) if stringify_objects else text

    def _event_payload_value(data: Any, *keys: str) -> Any:
        if isinstance(data, dict):
            for key in keys:
                if key in data:
                    return data.get(key)
        return None

    def _event_input_preview(data: Any) -> str:
        value = _event_payload_value(data, "input", "inputs", "args")
        if value is None and isinstance(data, dict):
            content = data.get("content")
            if isinstance(content, dict):
                value = content.get("args")
        if value is None:
            value = data
        return _event_text(value, stringify_objects=True).strip()

    def _event_output_text(data: Any) -> str:
        value = _event_payload_value(data, "output", "result", "return_value", "message")
        if value is None:
            value = data
        return _event_text(value, stringify_objects=True)

    def _event_chunk_text(data: Any) -> str:
        value = _event_payload_value(data, "chunk", "message", "delta", "content")
        if value is None:
            value = data
        return _event_text(value)

    def _content_block_payload(event: Any) -> Dict[str, Any] | None:
        event = _event_record(event)
        content = event.get("content") if isinstance(event, dict) else None
        if not isinstance(content, dict):
            data = _event_data(event)
            if isinstance(data, dict):
                content = data.get("content")
                if not isinstance(content, dict):
                    content = data.get("delta")
        return content if isinstance(content, dict) else None

    def _content_block_text(event: Any) -> str:
        content = _content_block_payload(event)
        if not content:
            return ""
        return _event_text(content.get("delta") or content.get("text") or content.get("content"))

    def _content_block_index(event: Any) -> str:
        data = _event_data(event)
        if isinstance(data, dict) and data.get("index") is not None:
            return str(data.get("index"))
        return "0"

    def _extract_content_block_interrupt_payload(event: Any) -> Dict[str, Any] | None:
        content = _content_block_payload(event)
        if not content or content.get("type") != "tool_call":
            return None
        name = str(content.get("name") or "").strip()
        if name not in _INTERRUPT_TOOL_NAMES:
            return None
        args = content.get("args")
        if isinstance(args, dict):
            return extract_interrupt_payload_from_tool_args(name, args)
        if isinstance(args, str):
            return extract_interrupt_payload_from_tool_call(name, args)
        return None

    def _extract_v3_interrupt_payload(
        event: Any,
        *,
        include_message_fallback: bool = True,
    ) -> Dict[str, Any] | None:
        event = _event_record(event)
        params = event.get("params") if isinstance(event, dict) else None
        if isinstance(params, dict):
            payload = _build_interrupt_payload(params.get("interrupts"))
            if payload:
                return payload
        data = _event_data(event)
        for candidate in (event, data):
            if isinstance(candidate, dict):
                payload = _build_interrupt_payload(candidate.get("__interrupt__"))
                if payload:
                    return payload
                interrupts = candidate.get("interrupts")
                payload = _build_interrupt_payload(interrupts)
                if payload:
                    return payload
                if str(candidate.get("type") or "").strip() == "interrupt":
                    normalized = normalize_interrupt_payload_value(candidate)
                    if normalized:
                        return normalized
                messages = _extract_messages(candidate)
                if include_message_fallback and messages:
                    for msg in reversed(messages):
                        payload = extract_interrupt_payload_from_tool_text(_message_to_text(msg))
                        if payload:
                            return payload
        return None

    async def _emit_v3_event(
        event: Any,
        handler: _CallbackStreamingHandler,
        *,
        suppress_interrupt_tool_start: bool,
    ) -> bool:
        """Map one LangChain/LangGraph v3 event into HelpUDoc's JSONL contract.

        Returns True when the event emitted a human interrupt and the run should pause.
        """
        method = _event_method(event)
        data = _event_data(event)
        run_key = _event_run_id(event) or method

        if method in {"on_chat_model_start", "on_llm_start", "message-start"}:
            name = _event_name(event) or "model"
            await _emit_progress(
                handler,
                "preparing_context",
                "Workspace context is ready",
                status="completed",
            )
            await _emit_progress(
                handler,
                "planning",
                "Thinking through the next step",
                status="running",
            )
            await handler._emit({"type": "model_start", "name": name})
            return False

        if method in {"on_chat_model_stream", "on_llm_stream", "messages"}:
            text = _event_chunk_text(data)
            text = strip_interrupt_payload_marker(text)
            if text and not _is_internal_stream_text(text):
                await handler._emit({"type": "token", "content": text, "role": "assistant"})
            return False

        if method in {"content-block-start", "content-block-delta", "content-block-finish"}:
            interrupt_payload = _extract_content_block_interrupt_payload(event)
            if interrupt_payload:
                # Tool-call streaming is not a durable human interrupt. Wait for
                # the actual graph interrupt after checkpoint persistence.
                return False
            block_key = (run_key, _content_block_index(event))
            if method == "content-block-start":
                handler._v3_text_blocks[block_key] = ""
                return False
            text = _content_block_text(event)
            text = strip_interrupt_payload_marker(text)
            if method == "content-block-delta":
                if text and not _is_internal_stream_text(text):
                    handler._v3_text_blocks[block_key] = handler._v3_text_blocks.get(block_key, "") + text
                    await handler._emit({"type": "token", "content": text, "role": "assistant"})
                return False

            # LangGraph v3 treats content-block-finish as authoritative. It is
            # often identical to the accumulated deltas, but middleware may
            # withhold a trailing look-behind window and only release it here.
            # Emit only that missing suffix so the final answer is complete
            # without appending the full Markdown document a second time.
            streamed_text = handler._v3_text_blocks.get(block_key, "")
            if not text or _is_internal_stream_text(text) or text == streamed_text:
                return False
            if text.startswith(streamed_text):
                missing_suffix = text[len(streamed_text):]
                handler._v3_text_blocks[block_key] = text
                if missing_suffix:
                    await handler._emit(
                        {"type": "token", "content": missing_suffix, "role": "assistant"}
                    )
                return False
            logger.warning(
                "LangGraph v3 content block finish diverged from streamed deltas "
                "(run=%s block=%s streamed_chars=%s final_chars=%s)",
                run_key,
                block_key[1],
                len(streamed_text),
                len(text),
            )
            return False

        if method in {"on_chat_model_end", "on_llm_end", "message-finish"}:
            await handler._emit({"type": "model_end", "name": _event_name(event) or "model"})
            return False

        if method in {"on_tool_start", "tools/start", "tool_start", "tool-started"}:
            name = _event_name(event) or "tool"
            handler._tool_names[run_key] = name
            preview = _event_input_preview(data)
            handler.record_tool_start(name, preview, run_key)
            if name in _INTERRUPT_TOOL_NAMES:
                # As above, let the tool establish its checkpoint before
                # presenting the corresponding form.
                return False
            await _emit_progress(
                handler,
                "using_tool",
                _friendly_tool_label(name),
                detail=name,
                tool_name=name,
                status="running",
            )
            await handler._emit(
                {
                    "type": "tool_start",
                    "name": name,
                    "content": preview[:200] if preview else "",
                }
            )
            return False

        if method in {"on_tool_end", "tools/end", "tool_end", "tool-finished"}:
            name = handler._tool_names.pop(run_key, _event_name(event) or "tool")
            text = _event_output_text(data)
            meta = handler._tool_meta.pop(run_key, None)
            if name in _INTERRUPT_TOOL_NAMES:
                interrupt_payload = extract_interrupt_payload_from_tool_text(text)
                if interrupt_payload:
                    handler.queue_pending_interrupt(interrupt_payload)
                    return False
                handler._resume_interrupt_consumed = True
            tool_failed = _is_terminal_tool_failure(name, text)
            await _emit_progress(
                handler,
                "using_tool",
                (
                    f"{_friendly_tool_label(name)} hit a timeout"
                    if tool_failed and name == "google_search" and "timed out" in text.lower()
                    else f"{_friendly_tool_label(name)} failed"
                    if tool_failed
                    else f"Finished {_friendly_tool_label(name)}"
                ),
                detail=("The agent will continue without retrying this tool." if tool_failed else name),
                tool_name=name,
                status="error" if tool_failed else "completed",
            )
            payload: Dict[str, Any] = {
                "type": "tool_error" if tool_failed else "tool_end",
                "name": name,
                "content": text,
            }
            output_files = _extract_output_files_from_tool_result(name, text)
            if meta and meta.get("files"):
                output_files.extend(meta["files"])
            if output_files:
                dedup: Dict[str, Dict[str, Any]] = {}
                for item in output_files:
                    path = str(item.get("path") or "").strip()
                    if path:
                        dedup[path] = item
                payload["outputFiles"] = list(dedup.values())
            if name == "load_skill":
                loaded_skill_id = _skill_id_from_loaded_skill_output(text)
                if loaded_skill_id:
                    patch_current_trace_skill(loaded_skill_id)
            if meta and meta.get("dashboardArtifact"):
                payload["dashboardArtifact"] = meta["dashboardArtifact"]
            await handler._emit(payload)
            return False

        if method in {"on_tool_error", "tools/error", "tool_error", "tool-error"}:
            name = handler._tool_names.pop(run_key, _event_name(event) or "tool")
            text = _event_output_text(data)
            if name in _INTERRUPT_TOOL_NAMES:
                interrupt_payload = extract_interrupt_payload_from_tool_text(text)
                if interrupt_payload:
                    handler.queue_pending_interrupt(interrupt_payload)
                    return False
            await _emit_progress(
                handler,
                "using_tool",
                f"Error in {_friendly_tool_label(name)}",
                detail=name,
                tool_name=name,
                status="error",
            )
            await handler._emit({"type": "tool_error", "name": name, "content": text})
            return False

        if method == "on_chain_stream":
            return False

        custom_name = ""
        custom_data = data
        if method == "on_custom_event":
            custom_name = _event_name(event)
        elif method in {"custom", "updates"} and isinstance(data, dict):
            custom_name = str(data.get("name") or data.get("type") or "").strip()
            custom_data = data.get("data") if "data" in data else data

        if custom_name == "tool_artifacts" and isinstance(custom_data, dict):
            bucket = handler._tool_meta.get(run_key) or {}
            bucket["files"] = list(custom_data.get("files") or [])
            handler._tool_meta[run_key] = bucket
            return False

        if custom_name == "dashboard_artifact" and isinstance(custom_data, dict):
            bucket = handler._tool_meta.get(run_key) or {}
            bucket["dashboardArtifact"] = custom_data
            handler._tool_meta[run_key] = bucket
            await handler._emit({"type": "dashboard_artifact", "dashboardArtifact": custom_data})
            return False

        return False

    def _extract_interrupt_from_exception(error: BaseException) -> Dict[str, Any] | None:
        if isinstance(error, BaseExceptionGroup):
            for inner in error.exceptions:
                payload = _extract_interrupt_from_exception(inner)
                if payload:
                    return payload
            return None
        if isinstance(error, GraphInterrupt):
            return _build_interrupt_payload(error.args[0] if error.args else None)
        return None

    def _active_skill_policy(runtime: AgentRuntimeState) -> Dict[str, Any]:
        context = runtime.workspace_state.context or {}
        raw_policy = context.get("active_skill_policy") or {}
        if not isinstance(raw_policy, dict):
            raw_policy = {}
        raw_limit = raw_policy.get("pre_plan_search_limit", 0)
        raw_used = context.get("pre_plan_search_count", 0)
        try:
            pre_plan_search_limit = max(0, int(raw_limit or 0))
        except (TypeError, ValueError):
            pre_plan_search_limit = 0
        try:
            pre_plan_search_used = max(0, int(raw_used or 0))
        except (TypeError, ValueError):
            pre_plan_search_used = 0
        return {
            "skill": context.get("active_skill"),
            "skillVersion": context.get("active_skill_version"),
            "requiresHitlPlan": bool(raw_policy.get("requires_hitl_plan", False)),
            "requiresArtifacts": bool(raw_policy.get("requires_workspace_artifacts", False)),
            "requiredArtifactsMode": raw_policy.get("required_artifacts_mode"),
            "prePlanSearchLimit": pre_plan_search_limit,
            "prePlanSearchUsed": pre_plan_search_used,
        }

    def _missing_required_artifacts(runtime: AgentRuntimeState) -> List[str]:
        context = runtime.workspace_state.context or {}
        policy = context.get("active_skill_policy") or {}
        if not isinstance(policy, dict):
            return []
        if not bool(policy.get("requires_workspace_artifacts", False)):
            return []
        root = runtime.workspace_state.root_path
        required = policy.get("required_artifacts") or []
        required_items = [str(item).strip() for item in required if str(item).strip()]
        if not required_items:
            return []
        missing: List[str] = []
        for item in required_items:
            if item.startswith("pattern:"):
                pattern = item[len("pattern:"):].lstrip("/")
                matched = False
                for child in root.rglob("*"):
                    if not child.is_file():
                        continue
                    rel = child.relative_to(root).as_posix()
                    if fnmatch.fnmatch(rel, pattern):
                        matched = True
                        break
                if not matched:
                    missing.append(item)
                continue
            rel = item.lstrip("/")
            if not (root / rel).exists():
                missing.append(item)
        return missing

    def _completion_plan_contract_error(runtime: AgentRuntimeState) -> str:
        context = runtime.workspace_state.context or {}
        if str(context.get("active_skill") or "").strip() != "data/dashboard":
            return ""
        policy = context.get("active_skill_policy") or {}
        if not isinstance(policy, dict) or not bool(policy.get("requires_hitl_plan", False)):
            return ""
        if bool(context.get("skip_plan_approvals")):
            return ""
        if bool(context.get("plan_approved") or context.get("host_plan_approved")):
            return ""
        return "The run cannot complete before its required plan has been reviewed and approved."

    def _reset_turn_context(runtime: AgentRuntimeState) -> None:
        context = runtime.workspace_state.context or {}
        skip_plan_approvals = bool(context.get("skip_plan_approvals"))
        # Skill execution state is per top-level user task. Resumes should preserve it,
        # but a fresh user turn should not inherit approval or active-skill state.
        context.pop("active_skill", None)
        context.pop("active_skill_scope", None)
        context.pop("active_skill_policy", None)
        context.pop("last_plan_feedback", None)
        context.pop("last_plan_file_path", None)
        context.pop("preferred_mcp_server", None)
        context.pop("tagged_files", None)
        context.pop("knowledge_refs", None)
        context.pop("loaded_skill_ids_this_turn", None)
        context.pop("skill_load_attempts_this_turn", None)
        context.pop("dashboard_mode", None)
        context.pop("frontend_slides_completed_interaction_gates", None)
        context.pop("interaction_gate_ledger", None)
        context.pop("interaction_gate_telemetry", None)
        context.pop("host_plan_approved", None)
        context.pop("host_dashboard_output_path", None)
        context.pop("host_dashboard_filters", None)
        context.pop("host_dashboard_time_field", None)
        context.pop("_native_dashboard_builder_executions", None)
        context.pop("_data_workspace_query_executions", None)
        context.pop("_current_sandbox_run_ids", None)
        reset_document_tool_run_state(context)
        context["plan_approved"] = skip_plan_approvals
        context["pre_plan_search_count"] = 0
        context["google_search_count"] = 0
        context.pop("google_search_terminal_error", None)

    async def _prepare_turn_payload(
        runtime: AgentRuntimeState,
        message: ChatRequest,
        *,
        fresh_turn: bool,
    ) -> List[Dict[str, Any]]:
        payload = _prepare_payload(message)
        if fresh_turn:
            _reset_turn_context(runtime)
            runtime.workspace_state.context.update(
                _merge_trace_gate_context(runtime.workspace_state.context, message.langfuseTraceContext)
            )
            runtime.workspace_state.context["internet_search_enabled"] = bool(message.internetSearchEnabled)
            runtime.workspace_state.context["knowledge_refs"] = [
                dict(item) for item in message.knowledgeRefs if isinstance(item, dict)
            ]
        payload, latest_user_text = _apply_embedded_directives(runtime, payload)
        if fresh_turn:
            payload, trace_skill_user_text = _inject_trace_skill_prompt(runtime, payload, message)
            if trace_skill_user_text is not None:
                latest_user_text = trace_skill_user_text
        if fresh_turn:
            memory_guidance = _build_memory_system_message(runtime)
            if memory_guidance:
                payload.insert(0, {"role": "system", "content": memory_guidance})

        prompt_for_tagged_files = latest_user_text
        if not prompt_for_tagged_files:
            for index in range(len(payload) - 1, -1, -1):
                role = str(payload[index].get("role") or "").strip().lower()
                if role in {"user", "human"}:
                    prompt_for_tagged_files = _extract_text_from_content(payload[index].get("content"))
                    break
        if not prompt_for_tagged_files:
            prompt_for_tagged_files = message.message or ""
        if message.internetSearchEnabled:
            internet_guidance = (
                "Internet search is enabled for this turn. "
                "Use the google_search tool for current, external, or web-grounded information before answering, "
                "and cite the useful sources it returns."
            )
            for index in range(len(payload) - 1, -1, -1):
                role = str(payload[index].get("role") or "").strip().lower()
                if role in {"user", "human"}:
                    payload[index]["content"] = _replace_content_text(
                        payload[index].get("content"),
                        f"{prompt_for_tagged_files.rstrip()}\n\n{internet_guidance}".strip(),
                    )
                    prompt_for_tagged_files = _extract_text_from_content(payload[index].get("content"))
                    break
        tagged_files = _extract_tagged_files(prompt_for_tagged_files)
        guided_prompt = _append_tagged_file_guidance(prompt_for_tagged_files, tagged_files)
        if guided_prompt != prompt_for_tagged_files:
            guidance_suffix = ""
            prompt_prefix = prompt_for_tagged_files.rstrip()
            if prompt_prefix and guided_prompt.startswith(prompt_prefix):
                guidance_suffix = guided_prompt[len(prompt_prefix):].strip()
            for index in range(len(payload) - 1, -1, -1):
                role = str(payload[index].get("role") or "").strip().lower()
                if role in {"user", "human"}:
                    current_content = payload[index].get("content")
                    current_text = _extract_text_from_content(current_content)
                    if guidance_suffix and current_text and current_text != prompt_for_tagged_files:
                        next_text = f"{current_text.rstrip()}\n\n{guidance_suffix}".strip()
                    else:
                        next_text = guided_prompt
                    payload[index]["content"] = _replace_content_text(current_content, next_text)
                    break
            prompt_for_tagged_files = guided_prompt
        runtime.workspace_state.context["tagged_files"] = tagged_files
        dashboard_mode = _build_dashboard_mode_context(runtime.workspace_state.context, tagged_files)
        if dashboard_mode is not None:
            runtime.workspace_state.context["dashboard_mode"] = dashboard_mode
        else:
            runtime.workspace_state.context.pop("dashboard_mode", None)
        _inject_host_datetime_context(payload)
        return payload



    def _emit_text(role: str, text: str) -> Iterable[Dict[str, str]]:
        if not text:
            return []
        if role in _ASSISTANT_ROLES:
            text = strip_interrupt_payload_marker(text)
            if not text:
                return []
            if _is_internal_stream_text(text):
                return []
            return [
                {"type": "token", "content": piece, "role": "assistant"}
                for piece in _chunk_text(text)
            ]
        if role in _TOOL_ROLES:
            return [
                {"type": "thought", "content": text, "role": role}
            ]
        return []

    def _synthetic_interaction_resume_text(resume_value: Any, gate_id: str) -> str:
        try:
            serialized = json.dumps(resume_value, ensure_ascii=False, sort_keys=True)
        except Exception:
            serialized = str(resume_value)
        return (
            "The user submitted the Interaction form for gate "
            f"'{gate_id}'. Continue the active skill workflow using this structured response:\n"
            f"{serialized}"
        )

    async def _stream_agent_response(
        runtime: AgentRuntimeState,
        message: ChatRequest,
        *,
        resume_decisions: Optional[List[Dict[str, Any]]] = None,
        resume_interrupt_id: str = "",
        resume_value: Any = None,
    ) -> AsyncGenerator[bytes, None]:
        agent = getattr(runtime, "agent", None)
        if agent is None:
            yield _json_line({"type": "error", "message": "Agent not initialized"})
            return
        prepare_plan_context_for_explicit_resume(runtime.workspace_state, resume_decisions)
        context = getattr(runtime.workspace_state, "context", None)
        # Document tool caching and loop breaking are scoped to one top-level
        # run: a fresh turn and every explicit resume start from clean state.
        reset_document_tool_run_state(context)
        manager = context.get("data_agent_manager") if isinstance(context, dict) else None
        if manager and hasattr(manager, "reset_session"):
            manager.reset_session()

        if resume_decisions is None and resume_value is None:
            payload = await _prepare_turn_payload(runtime, message, fresh_turn=True)
        else:
            payload = _prepare_payload(message)
            context = runtime.workspace_state.context
            synthetic_gate_id = ""
            if isinstance(context, dict) and resume_value is not None:
                synthetic_gate_id = str(context.pop("interaction_synthetic_interrupt_pending", "") or "").strip()
            if synthetic_gate_id:
                stored_payload = context.pop("interaction_synthetic_resume_payload", None) if isinstance(context, dict) else None
                if isinstance(stored_payload, list) and stored_payload:
                    payload = [dict(item) for item in stored_payload if isinstance(item, dict)]
                elif isinstance(context, dict):
                    prior_context = str(context.pop("interaction_synthetic_resume_context", "") or "").strip()
                    if prior_context:
                        payload = [
                            {
                                "role": "user",
                                "content": (
                                    "Continue the active skill workflow after this synthetic Interaction interruption. "
                                    "Previous assistant output before the form:\n"
                                    f"{prior_context}"
                                ),
                            }
                        ]
                payload.append({"role": "user", "content": _synthetic_interaction_resume_text(resume_value, synthetic_gate_id)})
                if isinstance(context, dict):
                    context["last_interaction_response"] = resume_value
                resume_value = None
        is_resume_stream = resume_decisions is not None or resume_value is not None
        approve_plan_resume = has_approved_plan_decision(resume_decisions)
        edit_plan_resume = has_edited_plan_decision(resume_decisions)
        reject_plan_resume = has_rejected_plan_decision(resume_decisions)
        dashboard_approval_resume = (
            approve_plan_resume
            and str(runtime.workspace_state.context.get("active_skill") or "") == "data/dashboard"
        )
        dashboard_edit_resume = (
            edit_plan_resume
            and str(runtime.workspace_state.context.get("active_skill") or "") == "data/dashboard"
        )
        allow_rejection_summary = False
        allow_approval_summary = False
        approval_resume_contract_error = ""
        expected_dashboard_title = (
            requested_dashboard_title(message.message)
            if str(runtime.workspace_state.context.get("active_skill") or "") == "data/dashboard"
            else ""
        )

        def _interrupt_plan_title(payload: Dict[str, Any]) -> str:
            display = payload.get("display_payload")
            if isinstance(display, dict):
                title = str(display.get("planTitle") or "").strip()
                if title:
                    return title
            interaction = payload.get("interactionRequest")
            if isinstance(interaction, dict):
                metadata = interaction.get("metadata")
                if isinstance(metadata, dict):
                    title = str(metadata.get("planTitle") or "").strip()
                    if title:
                        return title
                props = interaction.get("props")
                if isinstance(props, dict):
                    title = str(props.get("title") or "").strip()
                    if title:
                        return title
            return ""

        def _edit_resume_feedback() -> str:
            if not isinstance(resume_decisions, list):
                return ""
            for decision in resume_decisions:
                if not isinstance(decision, dict):
                    continue
                if str(decision.get("type") or "").strip().lower() != "edit":
                    continue
                edited_action = decision.get("edited_action") or decision.get("editedAction")
                args = edited_action.get("args") if isinstance(edited_action, dict) else {}
                if isinstance(args, dict):
                    feedback = str(args.get("reviewer_feedback") or "").strip()
                    if feedback:
                        return feedback
                return str(decision.get("message") or "").strip()
            return ""

        def _dashboard_package_snapshot() -> Dict[str, int]:
            root = runtime.workspace_state.root_path
            snapshot: Dict[str, int] = {}
            for path in root.glob("dashboards/*/dashboard.meta.json"):
                try:
                    snapshot[path.relative_to(root).as_posix()] = path.stat().st_mtime_ns
                except OSError:
                    continue
            return snapshot

        dashboard_packages_before = (
            _dashboard_package_snapshot() if dashboard_approval_resume else {}
        )
        suppress_dashboard_clarification_text = (
            resume_value is not None
            and str(runtime.workspace_state.context.get("active_skill") or "") == "data/dashboard"
        )

        def _should_suppress_assistant_text_for_interaction_gate() -> bool:
            context = getattr(runtime.workspace_state, "context", None)
            return (
                (reject_plan_resume and not allow_rejection_summary)
                or (dashboard_approval_resume and not allow_approval_summary)
                or edit_plan_resume
                or suppress_dashboard_clarification_text
                or next_pending_gate(context) is not None
            )

        handler = _CallbackStreamingHandler(
            _message_to_text,
            suppress_interrupt_tool_start=resume_decisions is not None or resume_value is not None,
            should_suppress_assistant_text=_should_suppress_assistant_text_for_interaction_gate,
        )
        sentinel = object()
        stream_started = asyncio.get_running_loop().time()
        saw_interrupt = False
        stream_error_message = ""
        defer_checkpoint_interrupt = is_resume_stream
        yield _json_line({"type": "policy", **_active_skill_policy(runtime)})
        logger.info(
            "Agent stream start: agent=%s workspace=%s",
            runtime.agent_name,
            runtime.workspace_state.workspace_id,
        )

        async def _agent_runner():
            lf_handlers = langfuse_langchain_callbacks()
            try:
                nonlocal saw_interrupt, defer_checkpoint_interrupt
                nonlocal allow_rejection_summary, allow_approval_summary
                nonlocal approval_resume_contract_error
                nonlocal stream_error_message
                await _emit_progress(
                    handler,
                    "preparing_context",
                    "Preparing workspace context",
                    status="running",
                )
                synthetic_gate = next_pending_gate(runtime.workspace_state.context)
                if synthetic_gate is not None and bool(synthetic_gate.get("synthetic_on_pending")):
                    record_gate_source(runtime.workspace_state.context, synthetic_gate, source="synthetic")
                    runtime.workspace_state.context["interaction_synthetic_interrupt_pending"] = str(
                        synthetic_gate.get("gate_id") or ""
                    )
                    runtime.workspace_state.context["interaction_synthetic_resume_payload"] = payload
                    interrupt_payload = normalize_interrupt_payload_value(
                        interaction_interrupt_value_for_gate(synthetic_gate)
                    )
                    saw_interrupt = True
                    await _emit_progress(
                        handler,
                        "awaiting_input",
                        "Awaiting your input to proceed",
                        status="pending",
                    )
                    await handler._emit(interrupt_payload)
                    return
                stream_config = _build_agent_config(
                    runtime,
                    message,
                    callbacks=lf_handlers or None,
                )
                if resume_decisions is not None:
                    decision_value = {"decisions": resume_decisions}
                    normalized_interrupt_id = str(resume_interrupt_id or "").strip()
                    pending_interrupt_ids: Set[str] = set()
                    resume_stream_config = stream_config
                    try:
                        checkpoint_state = await agent.aget_state(stream_config, subgraphs=True)
                        states_to_inspect = [checkpoint_state]
                        while states_to_inspect:
                            current_state = states_to_inspect.pop()
                            for pending_interrupt in getattr(current_state, "interrupts", ()) or ():
                                pending_id = str(getattr(pending_interrupt, "id", "") or "").strip()
                                if pending_id:
                                    pending_interrupt_ids.add(pending_id)
                                if pending_id == normalized_interrupt_id:
                                    nested_config = getattr(current_state, "config", None)
                                    if isinstance(nested_config, dict):
                                        resume_stream_config = {
                                            **nested_config,
                                            "callbacks": stream_config.get("callbacks"),
                                            "metadata": stream_config.get("metadata"),
                                            "tags": stream_config.get("tags"),
                                            "run_name": stream_config.get("run_name"),
                                        }
                            for task_state in getattr(current_state, "tasks", ()) or ():
                                for pending_interrupt in getattr(task_state, "interrupts", ()) or ():
                                    pending_id = str(getattr(pending_interrupt, "id", "") or "").strip()
                                    if pending_id:
                                        pending_interrupt_ids.add(pending_id)
                                    if pending_id == normalized_interrupt_id:
                                        nested_config = getattr(current_state, "config", None)
                                        if isinstance(nested_config, dict):
                                            resume_stream_config = {
                                                **nested_config,
                                                "callbacks": stream_config.get("callbacks"),
                                                "metadata": stream_config.get("metadata"),
                                                "tags": stream_config.get("tags"),
                                                "run_name": stream_config.get("run_name"),
                                            }
                                nested_state = getattr(task_state, "state", None)
                                if hasattr(nested_state, "tasks"):
                                    states_to_inspect.append(nested_state)
                    except Exception:
                        logger.debug("Unable to inspect pending interrupt ids", exc_info=True)
                    logger.warning(
                        "Dispatching plan decision resume "
                        "(thread_id=%s has_interrupt_id=%s pending_count=%s id_matches=%s)",
                        stream_config.get("configurable", {}).get("thread_id"),
                        bool(normalized_interrupt_id),
                        len(pending_interrupt_ids),
                        normalized_interrupt_id in pending_interrupt_ids,
                    )
                    if normalized_interrupt_id and normalized_interrupt_id not in pending_interrupt_ids:
                        approval_resume_contract_error = (
                            "The submitted plan decision could not be matched to a pending approval "
                            "checkpoint. The approval was not consumed; start a fresh run or request "
                            "the plan again."
                        )
                        return
                    if dashboard_approval_resume or dashboard_edit_resume:
                        context = runtime.workspace_state.context
                        decision_label = "approve" if dashboard_approval_resume else "edit"
                        context["last_plan_decision"] = decision_label
                        context["host_plan_approved"] = dashboard_approval_resume
                        context["host_dashboard_output_path"] = (
                            requested_dashboard_output_path(message.message)
                            if dashboard_approval_resume
                            else ""
                        )
                        context["host_dashboard_filters"] = (
                            requested_dashboard_filters(message.message)
                            if dashboard_approval_resume
                            else []
                        )
                        context["host_dashboard_time_field"] = (
                            requested_dashboard_time_field(message.message)
                            if dashboard_approval_resume
                            else ""
                        )
                        context["plan_approved"] = dashboard_approval_resume
                        context["skip_plan_approvals"] = False
                        base_thread_id = str(
                            stream_config.get("configurable", {}).get("thread_id") or uuid4()
                        )
                        resume_stream_config = {
                            **stream_config,
                            "configurable": {
                                **stream_config.get("configurable", {}),
                                "thread_id": f"{base_thread_id}:decision:{decision_label}",
                            },
                        }
                        original_request = (message.message or "").strip()
                        if dashboard_approval_resume:
                            decision_instruction = (
                                "The user approved the reviewed dashboard plan. Execute that exact plan now. "
                                "Do not request approval again. Generate the native dashboard package exactly "
                                "once and preserve every source row and value exactly as requested."
                            )
                        else:
                            decision_instruction = (
                                "The user requested revisions to the dashboard plan. Apply the reviewer feedback "
                                "below, then call request_plan_approval with the revised plan. Do not build any "
                                "dashboard files before the revised plan is approved.\n\n"
                                f"Reviewer feedback: {_edit_resume_feedback() or 'Apply the requested edits.'}"
                            )
                        stream_input = {
                            "messages": [
                                {
                                    "role": "user",
                                    "content": (
                                        f"{original_request}\n\n"
                                        f"HOST DECISION CONTINUATION:\n{decision_instruction}"
                                    ),
                                }
                            ]
                        }
                    else:
                        stream_input = Command(
                            resume=(
                                {normalized_interrupt_id: decision_value}
                                if normalized_interrupt_id
                                else decision_value
                            )
                        )
                elif resume_value is not None:
                    normalized_interrupt_id = str(resume_interrupt_id or "").strip()
                    stream_input = Command(
                        resume=(
                            {normalized_interrupt_id: resume_value}
                            if normalized_interrupt_id
                            else resume_value
                        )
                    )
                else:
                    stream_input = _validated_fresh_stream_input(payload, message.message)

                async def _consume_event_stream(
                    agent_input: Any,
                    *,
                    include_message_fallback: bool,
                    config_override: Dict[str, Any] | None = None,
                ) -> Tuple[Any, bool]:
                    nonlocal saw_interrupt, defer_checkpoint_interrupt
                    nonlocal approval_resume_contract_error
                    stream_result = None
                    pending_interrupt_payload: Dict[str, Any] | None = None
                    event_stream = agent.astream_events(
                        agent_input,
                        config=config_override or stream_config,
                        context=runtime.workspace_state.context,
                        version="v3",
                    )
                    if inspect.isawaitable(event_stream):
                        event_stream = await event_stream
                    async for event in event_stream:
                        data = _event_data(event)
                        method = _event_method(event)
                        if method in {"on_chain_end", "values", "updates"} and data is not None:
                            stream_result = data
                        interrupt_payload = _extract_v3_interrupt_payload(
                            event,
                            include_message_fallback=include_message_fallback,
                        )
                        if (
                            interrupt_payload is None
                            and method
                            in {
                                "content-block-start",
                                "content-block-delta",
                                "content-block-finish",
                            }
                        ):
                            interrupt_payload = _extract_content_block_interrupt_payload(event)
                        if (
                            interrupt_payload is None
                            and method in {"on_tool_end", "tools/end", "tool_end", "tool-finished"}
                        ):
                            run_key = _event_run_id(event) or method
                            tool_name = handler._tool_names.get(
                                run_key,
                                _event_name(event) or "tool",
                            )
                            if tool_name in _INTERRUPT_TOOL_NAMES:
                                interrupt_payload = extract_interrupt_payload_from_tool_text(
                                    _event_output_text(data)
                                )
                        if handler.resume_interrupt_consumed:
                            defer_checkpoint_interrupt = False
                        callback_interrupt_payload = handler.take_pending_interrupt()
                        if callback_interrupt_payload and not defer_checkpoint_interrupt:
                            pending_interrupt_payload = callback_interrupt_payload
                        if interrupt_payload and not defer_checkpoint_interrupt:
                            # Drain the graph event stream before exposing the
                            # form. Closing the generator on the first interrupt
                            # event can leave the checkpoint at the preceding
                            # model node, so a later decision never reaches the
                            # interrupted tool.
                            pending_interrupt_payload = interrupt_payload
                            continue
                        if await _emit_v3_event(
                            event,
                            handler,
                            suppress_interrupt_tool_start=is_resume_stream,
                        ):
                            saw_interrupt = True
                            return stream_result, True
                        if handler.resume_interrupt_consumed:
                            defer_checkpoint_interrupt = False
                    trailing_callback_interrupt = handler.take_pending_interrupt()
                    if trailing_callback_interrupt and not defer_checkpoint_interrupt:
                        pending_interrupt_payload = trailing_callback_interrupt
                    if pending_interrupt_payload is not None:
                        try:
                            checkpoint_state = await agent.aget_state(stream_config, subgraphs=True)
                            checkpoint_interrupt_ids = {
                                str(getattr(item, "id", "") or "").strip()
                                for item in (getattr(checkpoint_state, "interrupts", ()) or ())
                                if str(getattr(item, "id", "") or "").strip()
                            }
                            for task_state in getattr(checkpoint_state, "tasks", ()) or ():
                                checkpoint_interrupt_ids.update(
                                    str(getattr(item, "id", "") or "").strip()
                                    for item in (getattr(task_state, "interrupts", ()) or ())
                                    if str(getattr(item, "id", "") or "").strip()
                                )
                            logger.info(
                                "Prepared interrupt checkpoint "
                                "(thread_id=%s pending_count=%s payload_id=%s)",
                                stream_config.get("configurable", {}).get("thread_id"),
                                len(checkpoint_interrupt_ids),
                                str(pending_interrupt_payload.get("interruptId") or "").strip(),
                            )
                        except Exception:
                            logger.warning("Unable to inspect prepared interrupt checkpoint", exc_info=True)
                        if expected_dashboard_title:
                            proposed_title = _interrupt_plan_title(pending_interrupt_payload)
                            normalized_expected = " ".join(expected_dashboard_title.casefold().split())
                            normalized_proposed = " ".join(proposed_title.casefold().split())
                            if not proposed_title or normalized_expected not in normalized_proposed:
                                approval_resume_contract_error = (
                                    "The dashboard plan is stale or mismatched: expected a plan for "
                                    f"'{expected_dashboard_title}', but received "
                                    f"'{proposed_title or 'an untitled plan'}'."
                                )
                                return stream_result, False
                        saw_interrupt = True
                        await _emit_progress(
                            handler,
                            "awaiting_input",
                            "Awaiting your input to proceed",
                            status="pending",
                        )
                        await handler._emit(pending_interrupt_payload)
                        return stream_result, True
                    return stream_result, False

                final_result, interrupted = await _consume_event_stream(
                    stream_input,
                    include_message_fallback=not is_resume_stream,
                    config_override=resume_stream_config if resume_decisions is not None else None,
                )
                if interrupted:
                    return

                if (
                    resume_decisions is not None
                    and not (dashboard_approval_resume or dashboard_edit_resume)
                ):
                    if not handler.resume_interrupt_consumed:
                        approval_resume_contract_error = (
                            "The plan decision was accepted but not consumed by the pending approval "
                            "checkpoint. No approved work was executed."
                        )
                        return
                    await handler._emit(
                        {
                            "type": "interaction_consumed",
                            "interruptId": str(resume_interrupt_id or "").strip() or None,
                        }
                    )

                if resume_value is not None:
                    if not handler.resume_interrupt_consumed:
                        approval_resume_contract_error = (
                            "The clarification response was accepted but not consumed by the pending interaction."
                        )
                        return
                    await handler._emit(
                        {
                            "type": "interaction_consumed",
                            "interruptId": str(resume_interrupt_id or "").strip() or None,
                        }
                    )
                    context = runtime.workspace_state.context
                    policy = context.get("active_skill_policy") or {}
                    needs_dashboard_plan = (
                        str(context.get("active_skill") or "") == "data/dashboard"
                        and isinstance(policy, dict)
                        and bool(policy.get("requires_hitl_plan", False))
                        and not bool(context.get("skip_plan_approvals"))
                        and not bool(context.get("plan_approved") or context.get("host_plan_approved"))
                    )
                    if needs_dashboard_plan:
                        await _emit_progress(
                            handler,
                            "planning",
                            "Preparing the dashboard plan for review",
                            status="running",
                        )
                        defer_checkpoint_interrupt = False
                        final_result, interrupted = await _consume_event_stream(
                            {
                                "messages": [
                                    {
                                        "role": "user",
                                        "content": (
                                            "The dashboard clarification answers were consumed. Continue the original "
                                            "dashboard workflow now: draft the concrete dashboard plan and call "
                                            "request_plan_approval. Do not ask for the clarification questionnaire "
                                            "again, do not build dashboard files yet, and do not stop with prose."
                                        ),
                                    }
                                ]
                            },
                            include_message_fallback=False,
                        )
                        if interrupted:
                            return

                if edit_plan_resume:
                    context = runtime.workspace_state.context
                    if str(context.get("last_plan_decision") or "").strip().lower() != "edit":
                        approval_resume_contract_error = (
                            "The requested plan edits were not consumed by the pending plan."
                        )
                        return
                    await _emit_progress(
                        handler,
                        "planning",
                        "Revising the plan from reviewer feedback",
                        status="running",
                    )
                    defer_checkpoint_interrupt = False
                    feedback = _edit_resume_feedback()
                    continuation_input = {
                        "messages": [
                            {
                                "role": "user",
                                "content": (
                                    "Revise the pending plan using the review feedback below, then call "
                                    "request_plan_approval again. Do not execute the plan and do not stop "
                                    "with prose before producing the revised approval form.\n\n"
                                    f"Reviewer feedback: {feedback or 'Apply the requested plan edits.'}"
                                ),
                            }
                        ]
                    }
                    final_result, interrupted = await _consume_event_stream(
                        continuation_input,
                        include_message_fallback=False,
                        config_override=resume_stream_config,
                    )
                    if interrupted:
                        return
                    approval_resume_contract_error = (
                        "The plan edit was consumed, but the revised plan was not resubmitted for approval."
                    )
                    return

                if dashboard_approval_resume:
                    context = runtime.workspace_state.context
                    if not bool(
                        context.get("plan_approved") or context.get("host_plan_approved")
                    ):
                        approval_resume_contract_error = (
                            "The approval decision was not consumed by the pending dashboard plan."
                        )
                        return

                    dashboard_packages_after_resume = _dashboard_package_snapshot()
                    if dashboard_packages_after_resume == dashboard_packages_before:
                        await _emit_progress(
                            handler,
                            "executing",
                            "Continuing the approved dashboard plan",
                            status="running",
                        )
                        defer_checkpoint_interrupt = False
                        continuation_input = {
                            "messages": [
                                {
                                    "role": "user",
                                    "content": (
                                        "The user approved the pending dashboard plan. "
                                        "Continue executing that exact approved plan now. "
                                        "Do not request approval again and do not stop with approval-seeking prose. "
                                        "Generate the required native dashboard package exactly once."
                                    ),
                                }
                            ]
                        }
                        final_result, interrupted = await _consume_event_stream(
                            continuation_input,
                            include_message_fallback=False,
                            config_override=resume_stream_config,
                        )
                        if interrupted:
                            return

                    dashboard_packages_after = _dashboard_package_snapshot()
                    if dashboard_packages_after == dashboard_packages_before:
                        approval_resume_contract_error = (
                            "The approved dashboard run completed without generating or updating a package."
                        )
                        return
                    builder_executions = int(
                        context.get("_native_dashboard_builder_executions") or 0
                    )
                    if builder_executions != 1:
                        approval_resume_contract_error = (
                            "The approved dashboard must execute the native package builder exactly once; "
                            f"observed {builder_executions} executions."
                        )
                        return
                    allow_approval_summary = True
                    await handler._emit(
                        {
                            "type": "token",
                            "content": (
                                "The approved dashboard package was generated successfully "
                                "with the reviewed source-preservation rules."
                            ),
                            "role": "assistant",
                        }
                    )

                await _emit_progress(
                    handler,
                    "finalizing",
                    "Preparing final response",
                    status="running",
                )

                emitted = False
                if reject_plan_resume:
                    allow_rejection_summary = True
                    await handler._emit(
                        {
                            "type": "token",
                            "content": "The dashboard plan was rejected. No dashboard files were generated.",
                            "role": "assistant",
                        }
                    )
                    emitted = True
                interrupt_payload = _extract_v3_interrupt_payload(
                    final_result,
                    include_message_fallback=not is_resume_stream,
                )
                if interrupt_payload is None and not is_resume_stream:
                    interrupt_payload = _extract_interrupt_payload(final_result)
                if interrupt_payload:
                    saw_interrupt = True
                    emitted = True
                    await _emit_progress(
                        handler,
                        "awaiting_input",
                        "Awaiting your input to proceed",
                        status="pending",
                    )
                    await handler._emit(interrupt_payload)
                    return

                messages = _extract_messages(final_result)
                if messages and not handler.has_assistant_text:
                    tracker = _DeltaTracker()
                    for msg in messages:
                        text = _message_to_text(msg)
                        role = _message_role(msg)
                        delta = tracker.push(role, text)
                        if delta:
                            emitted = True
                            for event_payload in _emit_text(role, delta):
                                await handler._emit(event_payload)
                elif final_result is not None and not handler.has_assistant_text:
                    text = _message_to_text(final_result)
                    text = strip_interrupt_payload_marker(text)
                    if text and not _is_internal_stream_text(text):
                        emitted = True
                        for event_payload in _emit_text("assistant", text):
                            await handler._emit(event_payload)

                if not emitted and not handler.has_events:
                    await handler._emit(
                        {
                            "type": "thought",
                            "role": "assistant",
                            "content": "Model returned no output",
                        }
                    )
            except GraphInterrupt as exc:
                interrupt_payload = _extract_interrupt_from_exception(exc)
                if interrupt_payload:
                    saw_interrupt = True
                    await _emit_progress(
                        handler,
                        "awaiting_input",
                        "Awaiting your input to proceed",
                        status="pending",
                    )
                    await handler._emit(interrupt_payload)
                    return
                raise
            except asyncio.CancelledError:
                if handler.interrupt_emitted:
                    saw_interrupt = True
                    return
                raise
            except Exception as exc:  # pragma: no cover - streaming guard
                if isinstance(exc, GraphRecursionError):
                    error_message = (
                        "Agent stopped after reaching the LangGraph recursion limit of "
                        f"{_configured_recursion_limit(settings)} steps. "
                        f"Original error: {_format_exception(exc)}"
                    )
                else:
                    error_message = _format_exception(exc)
                stream_error_message = error_message
                logger.exception("Agent stream error: %s", error_message)
                await handler._emit({"type": "error", "message": error_message})
                await _emit_progress(
                    handler,
                    "failed",
                    "Execution failed",
                    detail=error_message,
                    status="error",
                )
                # Do not re-raise: the terminal `done` event below must carry the
                # original cause instead of tearing down the HTTP response and
                # surfacing a transport abort in run history.
            finally:
                elapsed = asyncio.get_running_loop().time() - stream_started
                logger.info(
                    "Agent stream finished: agent=%s workspace=%s elapsed=%.2fs",
                    runtime.agent_name,
                    runtime.workspace_state.workspace_id,
                    elapsed,
                )
                try:
                    lf_ev = emit_langfuse_trace_payload(lf_handlers)
                    if lf_ev:
                        await handler._emit({"type": "langfuse", **lf_ev})
                except Exception:
                    logger.debug("Langfuse trace payload skipped", exc_info=True)
                await handler.queue.put(sentinel)

        task = asyncio.create_task(_agent_runner())
        handler.attach_cancel(task.cancel)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(handler.queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield _json_line({"type": "keepalive"})
                    continue
                if event is sentinel:
                    break
                yield _json_line(event)
            source_tracker.update_final_report(runtime.workspace_state)
            if saw_interrupt:
                yield _json_line({"type": "done", "status": "interrupted"})
            elif stream_error_message:
                # Preserve the original Python cause (including
                # GraphRecursionError) on the terminal event so the Node
                # lifecycle records it instead of a transport abort.
                yield _json_line(
                    {
                        "type": "done",
                        "status": "failed",
                        "error": stream_error_message,
                    }
                )
            elif approval_resume_contract_error:
                yield _json_line({
                    "type": "progress",
                    "phase": "failed",
                    "label": "Dashboard interaction contract failed",
                    "detail": approval_resume_contract_error,
                    "status": "error",
                    "timestamp": datetime.utcnow().isoformat() + "Z",
                })
                yield _json_line(
                    {
                        "type": "contract_error",
                        "message": approval_resume_contract_error,
                    }
                )
                yield _json_line({"type": "done", "status": "failed"})
            else:
                plan_contract_error = (
                    ""
                    if reject_plan_resume
                    else _completion_plan_contract_error(runtime)
                )
                missing = _missing_required_artifacts(runtime)
                if plan_contract_error:
                    yield _json_line({
                        "type": "progress",
                        "phase": "failed",
                        "label": "Plan approval contract not satisfied",
                        "detail": plan_contract_error,
                        "status": "error",
                        "timestamp": datetime.utcnow().isoformat() + "Z",
                    })
                    yield _json_line(
                        {
                            "type": "contract_error",
                            "message": plan_contract_error,
                        }
                    )
                    yield _json_line({"type": "done", "status": "failed"})
                elif missing:
                    runtime.workspace_state.context["artifact_contract_failed"] = True
                    yield _json_line({
                        "type": "progress",
                        "phase": "failed",
                        "label": "Artifact contract not satisfied",
                        "status": "error",
                        "timestamp": datetime.utcnow().isoformat() + "Z",
                    })
                    yield _json_line(
                        {
                            "type": "contract_error",
                            "message": "Artifact contract not satisfied.",
                            "missing": missing,
                        }
                    )
                    yield _json_line({"type": "done", "status": "failed"})
                else:
                    yield _json_line({
                        "type": "progress",
                        "phase": "completed",
                        "label": "Completed response generation",
                        "status": "completed",
                        "timestamp": datetime.utcnow().isoformat() + "Z",
                    })
                    yield _json_line({"type": "done", "status": "completed"})
        finally:
            await task

    @app.post("/agents/{agent_name}/workspace/{workspace_id}/chat", response_model=ChatResponse)
    async def chat(agent_name: str, workspace_id: str, chat_request: ChatRequest, request: Request):
        try:
            initial_context = _seed_initial_skill_context(_extract_request_context(request), chat_request)
            runtime = await registry.get_or_create(agent_name, workspace_id, initial_context=initial_context)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        result = await _invoke_agent(runtime, chat_request)
        source_tracker.update_final_report(runtime.workspace_state)
        return ChatResponse(reply=result)

    @app.post("/agents/{agent_name}/workspace/{workspace_id}/chat/stream")
    async def chat_stream(agent_name: str, workspace_id: str, chat_request: ChatRequest, request: Request):
        try:
            initial_context = _seed_initial_skill_context(_extract_request_context(request), chat_request)
            runtime = await registry.get_or_create(agent_name, workspace_id, initial_context=initial_context)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        stream = _stream_agent_response(runtime, chat_request)
        return StreamingResponse(stream, media_type="application/jsonl")

    @app.post("/agents/{agent_name}/workspace/{workspace_id}/chat/stream/resume")
    async def chat_stream_resume(
        agent_name: str,
        workspace_id: str,
        resume_request: ResumeChatRequest,
        request: Request,
    ):
        try:
            initial_context = _merge_trace_gate_context(
                _extract_request_context(request),
                resume_request.langfuseTraceContext,
            )
            runtime = await registry.get_or_create(agent_name, workspace_id, initial_context=initial_context)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        decisions_payload: List[Dict[str, Any]] = []
        for item in resume_request.decisions:
            if hasattr(item, "model_dump"):
                decisions_payload.append(item.model_dump(exclude_none=True))  # type: ignore[attr-defined]
            else:
                decisions_payload.append(item.dict(exclude_none=True))  # type: ignore[attr-defined]
        placeholder = ChatRequest(
            message=resume_request.originalPrompt or "",
            history=None,
            forceReset=False,
            langfuseTraceContext=resume_request.langfuseTraceContext,
        )
        stream = _stream_agent_response(
            runtime,
            placeholder,
            resume_decisions=decisions_payload,
            resume_interrupt_id=resume_request.interruptId or "",
        )
        return StreamingResponse(stream, media_type="application/jsonl")

    @app.post("/agents/{agent_name}/workspace/{workspace_id}/chat/stream/respond")
    async def chat_stream_respond(
        agent_name: str,
        workspace_id: str,
        response_request: InterruptResponseRequest,
        request: Request,
    ):
        try:
            initial_context = _merge_trace_gate_context(
                _extract_request_context(request),
                response_request.langfuseTraceContext,
            )
            runtime = await registry.get_or_create(agent_name, workspace_id, initial_context=initial_context)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        if hasattr(response_request, "model_dump"):
            response_payload = response_request.model_dump(
                exclude_none=True,
                exclude={"langfuseTraceContext", "interruptId"},
            )  # type: ignore[attr-defined]
        else:
            response_payload = response_request.dict(
                exclude_none=True,
                exclude={"langfuseTraceContext", "interruptId"},
            )  # type: ignore[attr-defined]
        placeholder = ChatRequest(
            message="",
            history=None,
            forceReset=False,
            langfuseTraceContext=response_request.langfuseTraceContext,
        )
        stream = _stream_agent_response(
            runtime,
            placeholder,
            resume_value=response_payload,
            resume_interrupt_id=response_request.interruptId or "",
        )
        return StreamingResponse(stream, media_type="application/jsonl")

    @app.post("/agents/{agent_name}/workspace/{workspace_id}/chat/stream/act")
    async def chat_stream_act(
        agent_name: str,
        workspace_id: str,
        action_request: InterruptActionRequest,
        request: Request,
    ):
        try:
            initial_context = _merge_trace_gate_context(
                _extract_request_context(request),
                action_request.langfuseTraceContext,
            )
            runtime = await registry.get_or_create(agent_name, workspace_id, initial_context=initial_context)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        if hasattr(action_request, "model_dump"):
            action_payload = action_request.model_dump(exclude_none=True, exclude={"langfuseTraceContext"})  # type: ignore[attr-defined]
        else:
            action_payload = action_request.dict(exclude_none=True, exclude={"langfuseTraceContext"})  # type: ignore[attr-defined]
        placeholder = ChatRequest(
            message="",
            history=None,
            forceReset=False,
            langfuseTraceContext=action_request.langfuseTraceContext,
        )
        stream = _stream_agent_response(runtime, placeholder, resume_value=action_payload)
        return StreamingResponse(stream, media_type="application/jsonl")
