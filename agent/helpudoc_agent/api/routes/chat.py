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
from langgraph.errors import GraphInterrupt
from langgraph.types import Command

from helpudoc_agent.configuration import Settings
from helpudoc_agent.a2ui_contract import (
    a2ui_interrupt_value_for_gate,
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
from helpudoc_agent.rag_worker import RagIndexWorker
from helpudoc_agent.runtime.agent_registry import AgentRegistry
from helpudoc_agent.skills_registry import (
    activate_skill_context,
    build_loaded_skill_text,
    collect_tool_names,
    find_skill,
    is_skill_allowed,
    load_skills,
    read_helpudoc_learnings,
    read_skill_content,
)
from helpudoc_agent.state import AgentRuntimeState
from helpudoc_agent.tools_and_schemas import GeminiClientManager
from helpudoc_agent.utils import SourceTracker

from ..attachment_processing import _lc_ai_message_text
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
    _append_artifact_first_guidance,
    _append_tagged_file_guidance,
    _build_dashboard_mode_context,
    _build_dashboard_runtime_guidance,
    _build_tagged_rag_keywords,
    _compress_tagged_context_lines,
    _extract_html_outline_from_path,
    _extract_tagged_files_from_text,
    _filter_rag_chunks_to_tagged_paths,
    _filter_rag_prefetchable_tagged_files,
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


def _is_terminal_tool_failure(name: str, text: str) -> bool:
    normalized_name = str(name or "").strip().lower()
    normalized_text = str(text or "").strip().lower()
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


def register_chat_routes(
    app: FastAPI,
    *,
    settings: Settings,
    memory_store_manager: MemoryStoreManager,
    registry: AgentRegistry,
    rag_worker: RagIndexWorker,
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
            for extra in ("list_skills", "load_skill", "request_ui", "workflow_action"):
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
        skill = find_skill(settings.backend.skills_root, skill_id)
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
        skill = find_skill(settings.backend.skills_root, skill_id)
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
        gate_state = trace.get("a2uiGateState")
        completed_gates = gate_state.get("completedGateIds") if isinstance(gate_state, dict) else None
        if isinstance(completed_gates, list):
            normalized_gates = [
                str(item).strip()
                for item in completed_gates
                if str(item).strip()
            ]
            if normalized_gates:
                merged["frontend_slides_completed_a2ui_gates"] = normalized_gates
                ledger = merged.get("a2ui_gate_ledger")
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
                            "component": "",
                            "status": "completed",
                            "source": "direct",
                            "answers": None,
                            "created_at": now,
                            "updated_at": now,
                            "completed_at": now,
                            "violation_count": 0,
                        }
                    )
                merged["a2ui_gate_ledger"] = ledger_items
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
                skill = find_skill(settings.backend.skills_root, directive.skillId)
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

    def _normalize_file_context_refs(raw_refs: Any) -> List[Dict[str, Any]]:
        normalized: List[Dict[str, Any]] = []
        if not isinstance(raw_refs, list):
            return normalized
        for item in raw_refs:
            if not isinstance(item, dict):
                continue
            source_name = str(item.get("sourceName") or "").strip()
            fingerprint = str(item.get("sourceVersionFingerprint") or "").strip()
            artifact_id = str(item.get("artifactId") or "").strip()
            if not source_name or not fingerprint or not artifact_id:
                continue
            normalized.append(
                {
                    "sourceFileId": item.get("sourceFileId"),
                    "sourceName": source_name,
                    "sourceMimeType": str(item.get("sourceMimeType") or "").strip() or None,
                    "sourceVersionFingerprint": fingerprint,
                    "artifactId": artifact_id,
                    "artifactVersion": item.get("artifactVersion"),
                    "derivedArtifactFileId": item.get("derivedArtifactFileId"),
                    "derivedArtifactPath": str(item.get("derivedArtifactPath") or "").strip() or None,
                    "effectiveMode": str(item.get("effectiveMode") or "part").strip() or "part",
                    "status": str(item.get("status") or "failed").strip() or "failed",
                    "summary": str(item.get("summary") or "").strip() or None,
                    "lastError": str(item.get("lastError") or "").strip() or None,
                }
            )
        return normalized

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

    async def _prefetch_rag_context(
        workspace_id: str,
        prompt: str,
        tagged_paths_override: Sequence[str] | None = None,
    ) -> str | None:
        # Use extraction rather than relying on an exact marker string so backend text can evolve.
        if not prompt and not tagged_paths_override:
            return None
        tagged_paths = list(tagged_paths_override or _extract_tagged_files(prompt))
        rag_tagged_paths = _filter_rag_prefetchable_tagged_files(tagged_paths)
        if not rag_tagged_paths:
            return None
        keywords = _build_tagged_rag_keywords(prompt, rag_tagged_paths)
        rag_prompt = prompt
        if len(rag_tagged_paths) != len(tagged_paths):
            filtered_lines = ["Tagged files:"] + [f"- {path}" for path in rag_tagged_paths]
            rag_prompt = re.sub(
                r"(^|\n)Tagged files:\n(?:- .*(?:\n|$))+",
                ("\n" if "\nTagged files:" in prompt else "") + "\n".join(filtered_lines) + "\n",
                prompt,
                count=1,
            )
        try:
            response = await rag_worker.store.query_data(
                workspace_id,
                rag_prompt,
                mode="naive",
                include_references=False,
                hl_keywords=keywords,
                ll_keywords=keywords,
            )
            data = response.get("data") if isinstance(response, dict) else None
            chunks = data.get("chunks", []) if isinstance(data, dict) else []
            chunks = _filter_rag_chunks_to_tagged_paths(chunks, rag_tagged_paths)
            lines: List[str] = []
            for chunk in chunks:
                content = chunk.get("content") or ""
                if content and content.lstrip().startswith("SOURCE:"):
                    lines.append(content)
            if not lines:
                for chunk in chunks:
                    content = (chunk.get("content") or "").strip()
                    if not content:
                        continue
                    lines.append(content)
            if lines:
                non_textual = 0
                for content in lines:
                    lowered = content.lower()
                    if lowered.startswith("table analysis:") or lowered.startswith("discarded content analysis:"):
                        non_textual += 1
                if non_textual < len(lines):
                    compressed = _compress_tagged_context_lines(lines)
                    if compressed:
                        return compressed
            response = await rag_worker.store.query_data(
                workspace_id,
                rag_prompt,
                mode="hybrid",
                include_references=False,
                hl_keywords=keywords,
                ll_keywords=keywords,
            )
            data = response.get("data") if isinstance(response, dict) else None
            chunks = data.get("chunks", []) if isinstance(data, dict) else []
            chunks = _filter_rag_chunks_to_tagged_paths(chunks, rag_tagged_paths)
            lines = []
            for chunk in chunks:
                content = (chunk.get("content") or "").strip()
                if not content:
                    continue
                lines.append(content)
            if lines:
                non_textual = 0
                for content in lines:
                    lowered = content.lower()
                    if lowered.startswith("table analysis:") or lowered.startswith("discarded content analysis:"):
                        non_textual += 1
                if non_textual < len(lines):
                    compressed = _compress_tagged_context_lines(lines)
                    if compressed:
                        return compressed
            html_outline = _load_tagged_html_outline(workspace_id, rag_tagged_paths)
            if html_outline:
                return html_outline
            return None
        except Exception:
            logger.exception("Failed to prefetch RAG context for tagged files.")
            return None

    def _get_thread_id(runtime: AgentRuntimeState, force_reset: bool) -> str:
        context = runtime.workspace_state.context
        if force_reset or not context.get("thread_id"):
            suffix = ""
            if isinstance(context, dict):
                user_id = context.get("user_id")
                if isinstance(user_id, str) and user_id.strip():
                    suffix = f":{user_id.strip()}"
            base = f"{runtime.agent_name}:{runtime.workspace_state.workspace_id}{suffix}"
            if force_reset:
                thread_id = f"{base}:{uuid4()}"
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
        thread_id = _get_thread_id(runtime, message.forceReset)
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
            if name in _INTERRUPT_TOOL_NAMES:
                # On resumed human-interrupt flows, let the tool consume the
                # resume payload first. Eagerly re-emitting the interrupt here can
                # cancel the resumed run before the answer is applied.
                if self._suppress_interrupt_tool_start:
                    return
                interrupt_payload = extract_interrupt_payload_from_tool_call(name, input_str)
                if interrupt_payload:
                    self._interrupt_emitted = True
                    await _emit_progress(
                        self,
                        "awaiting_input",
                        "Preparing clarification question",
                        detail=name,
                        tool_name=name,
                        status="pending",
                    )
                    await self._emit(interrupt_payload)
                    if self._cancel_run:
                        self._cancel_run()
                    return
            preview = input_str.strip()
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
                    await _emit_progress(
                        self,
                        "awaiting_input",
                        "Preparing clarification question",
                        detail=name,
                        tool_name=name,
                        status="pending",
                    )
                    await self._emit(interrupt_payload)
                    return
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
        text = _lc_ai_message_text(value) or _message_to_text(value)
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

    def _extract_v3_interrupt_payload(event: Any) -> Dict[str, Any] | None:
        event = _event_record(event)
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
                if messages:
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
            if interrupt_payload and not suppress_interrupt_tool_start:
                content = _content_block_payload(event) or {}
                handler._interrupt_emitted = True
                await _emit_progress(
                    handler,
                    "awaiting_input",
                    "Preparing clarification question",
                    detail=str(content.get("name") or ""),
                    tool_name=str(content.get("name") or ""),
                    status="pending",
                )
                await handler._emit(interrupt_payload)
                return True
            text = _content_block_text(event)
            text = strip_interrupt_payload_marker(text)
            if text and not _is_internal_stream_text(text):
                await handler._emit({"type": "token", "content": text, "role": "assistant"})
            return False

        if method in {"on_chat_model_end", "on_llm_end", "message-finish"}:
            await handler._emit({"type": "model_end", "name": _event_name(event) or "model"})
            return False

        if method in {"on_tool_start", "tools/start", "tool_start", "tool-started"}:
            name = _event_name(event) or "tool"
            handler._tool_names[run_key] = name
            preview = _event_input_preview(data)
            if name in _INTERRUPT_TOOL_NAMES and not suppress_interrupt_tool_start:
                interrupt_payload = extract_interrupt_payload_from_tool_call(name, preview)
                if interrupt_payload:
                    handler._interrupt_emitted = True
                    await _emit_progress(
                        handler,
                        "awaiting_input",
                        "Preparing clarification question",
                        detail=name,
                        tool_name=name,
                        status="pending",
                    )
                    await handler._emit(interrupt_payload)
                    return True
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
                    await _emit_progress(
                        handler,
                        "awaiting_input",
                        "Preparing clarification question",
                        detail=name,
                        tool_name=name,
                        status="pending",
                    )
                    await handler._emit(interrupt_payload)
                    return True
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
                    handler._interrupt_emitted = True
                    await _emit_progress(
                        handler,
                        "awaiting_input",
                        "Preparing clarification question",
                        detail=name,
                        tool_name=name,
                        status="pending",
                    )
                    await handler._emit(interrupt_payload)
                    return True
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
        context.pop("tagged_rag_context", None)
        context.pop("loaded_skill_ids_this_turn", None)
        context.pop("skill_load_attempts_this_turn", None)
        context.pop("dashboard_mode", None)
        context.pop("frontend_slides_completed_a2ui_gates", None)
        context.pop("a2ui_gate_ledger", None)
        context.pop("a2ui_gate_telemetry", None)
        context["tagged_files_only"] = False
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
        message_file_context_refs = _normalize_file_context_refs(message.fileContextRefs)
        if message_file_context_refs:
            runtime.workspace_state.context["file_context_refs"] = message_file_context_refs
        active_file_context_refs = _normalize_file_context_refs(runtime.workspace_state.context.get("file_context_refs"))
        explicit_artifact_paths = [
            str(item.get("derivedArtifactPath") or "").strip()
            for item in active_file_context_refs
            if str(item.get("status") or "").strip().lower() in {"ready", "partial"}
            and str(item.get("derivedArtifactPath") or "").strip()
        ]
        pending_files = [
            str(item.get("sourceName") or "").strip()
            for item in active_file_context_refs
            if str(item.get("status") or "").strip().lower() == "pending"
        ]
        tagged_files = explicit_artifact_paths or _extract_tagged_files(prompt_for_tagged_files)
        guided_prompt = _append_tagged_file_guidance(prompt_for_tagged_files, tagged_files)
        guided_prompt = _append_artifact_first_guidance(
            guided_prompt,
            active_file_context_refs,
            tagged_files,
            multimodal_active=bool(message.messageContent),
        )
        if pending_files:
            pending_note = (
                "Attached files still being processed: "
                + ", ".join(pending_files)
                + ". Be explicit that understanding is still in progress."
            )
            guided_prompt = f"{guided_prompt.rstrip()}\n\n{pending_note}".strip()
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
        tagged_files_rag_only = (os.getenv("TAGGED_FILES_RAG_ONLY", "false") or "false").strip().lower() in {
            "1",
            "true",
            "yes",
            "y",
            "on",
        }
        runtime.workspace_state.context["tagged_files_only"] = bool(tagged_files) and tagged_files_rag_only
        if tagged_files:
            rag_context = await _prefetch_rag_context(
                runtime.workspace_state.workspace_id,
                prompt_for_tagged_files,
                tagged_paths_override=tagged_files,
            )
            if rag_context:
                runtime.workspace_state.context["tagged_rag_context"] = rag_context
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

    def _synthetic_a2ui_resume_text(resume_value: Any, gate_id: str) -> str:
        try:
            serialized = json.dumps(resume_value, ensure_ascii=False, sort_keys=True)
        except Exception:
            serialized = str(resume_value)
        return (
            "The user submitted the A2UI form for gate "
            f"'{gate_id}'. Continue the active skill workflow using this structured response:\n"
            f"{serialized}"
        )

    async def _stream_agent_response(
        runtime: AgentRuntimeState,
        message: ChatRequest,
        *,
        resume_decisions: Optional[List[Dict[str, Any]]] = None,
        resume_value: Any = None,
    ) -> AsyncGenerator[bytes, None]:
        agent = getattr(runtime, "agent", None)
        if agent is None:
            yield _json_line({"type": "error", "message": "Agent not initialized"})
            return
        context = getattr(runtime.workspace_state, "context", None)
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
                synthetic_gate_id = str(context.pop("a2ui_synthetic_interrupt_pending", "") or "").strip()
            if synthetic_gate_id:
                stored_payload = context.pop("a2ui_synthetic_resume_payload", None) if isinstance(context, dict) else None
                if isinstance(stored_payload, list) and stored_payload:
                    payload = [dict(item) for item in stored_payload if isinstance(item, dict)]
                elif isinstance(context, dict):
                    prior_context = str(context.pop("a2ui_synthetic_resume_context", "") or "").strip()
                    if prior_context:
                        payload = [
                            {
                                "role": "user",
                                "content": (
                                    "Continue the active skill workflow after this synthetic A2UI interruption. "
                                    "Previous assistant output before the form:\n"
                                    f"{prior_context}"
                                ),
                            }
                        ]
                payload.append({"role": "user", "content": _synthetic_a2ui_resume_text(resume_value, synthetic_gate_id)})
                if isinstance(context, dict):
                    context["last_a2ui_response"] = resume_value
                resume_value = None
        def _should_suppress_assistant_text_for_a2ui_gate() -> bool:
            context = getattr(runtime.workspace_state, "context", None)
            return next_pending_gate(context) is not None

        handler = _CallbackStreamingHandler(
            _message_to_text,
            suppress_interrupt_tool_start=resume_decisions is not None or resume_value is not None,
            should_suppress_assistant_text=_should_suppress_assistant_text_for_a2ui_gate,
        )
        sentinel = object()
        stream_started = asyncio.get_running_loop().time()
        saw_interrupt = False
        yield _json_line({"type": "policy", **_active_skill_policy(runtime)})
        logger.info(
            "Agent stream start: agent=%s workspace=%s",
            runtime.agent_name,
            runtime.workspace_state.workspace_id,
        )

        async def _agent_runner():
            lf_handlers = langfuse_langchain_callbacks()
            try:
                nonlocal saw_interrupt
                await _emit_progress(
                    handler,
                    "preparing_context",
                    "Preparing workspace context",
                    status="running",
                )
                synthetic_gate = next_pending_gate(runtime.workspace_state.context)
                if synthetic_gate is not None and bool(synthetic_gate.get("synthetic_on_pending")):
                    record_gate_source(runtime.workspace_state.context, synthetic_gate, source="synthetic")
                    runtime.workspace_state.context["a2ui_synthetic_interrupt_pending"] = str(
                        synthetic_gate.get("gate_id") or ""
                    )
                    runtime.workspace_state.context["a2ui_synthetic_resume_payload"] = payload
                    interrupt_payload = normalize_interrupt_payload_value(
                        a2ui_interrupt_value_for_gate(synthetic_gate)
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
                stream_input: Any = {"messages": payload}
                if resume_decisions is not None:
                    stream_input = Command(resume={"decisions": resume_decisions})
                elif resume_value is not None:
                    stream_input = Command(resume=resume_value)
                final_result = None
                event_stream = agent.astream_events(
                    stream_input,
                    config=stream_config,
                    context=runtime.workspace_state.context,
                    version="v3",
                )
                if inspect.isawaitable(event_stream):
                    event_stream = await event_stream
                async for event in event_stream:
                    data = _event_data(event)
                    method = _event_method(event)
                    if method in {"on_chain_end", "values", "updates"} and data is not None:
                        final_result = data
                    interrupt_payload = _extract_v3_interrupt_payload(event)
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
                    if await _emit_v3_event(
                        event,
                        handler,
                        suppress_interrupt_tool_start=resume_decisions is not None or resume_value is not None,
                    ):
                        saw_interrupt = True
                        return

                await _emit_progress(
                    handler,
                    "finalizing",
                    "Preparing final response",
                    status="running",
                )

                emitted = False
                interrupt_payload = _extract_v3_interrupt_payload(final_result) or _extract_interrupt_payload(final_result)
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
                error_message = _format_exception(exc)
                logger.exception("Agent stream error: %s", error_message)
                await handler._emit({"type": "error", "message": error_message})
                await _emit_progress(
                    handler,
                    "failed",
                    "Execution failed",
                    detail=error_message,
                    status="error",
                )
                raise
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
            else:
                missing = _missing_required_artifacts(runtime)
                if missing:
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
            message="",
            history=None,
            forceReset=False,
            langfuseTraceContext=resume_request.langfuseTraceContext,
        )
        stream = _stream_agent_response(runtime, placeholder, resume_decisions=decisions_payload)
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
            response_payload = response_request.model_dump(exclude_none=True, exclude={"langfuseTraceContext"})  # type: ignore[attr-defined]
        else:
            response_payload = response_request.dict(exclude_none=True, exclude={"langfuseTraceContext"})  # type: ignore[attr-defined]
        placeholder = ChatRequest(
            message="",
            history=None,
            forceReset=False,
            langfuseTraceContext=response_request.langfuseTraceContext,
        )
        stream = _stream_agent_response(runtime, placeholder, resume_value=response_payload)
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
