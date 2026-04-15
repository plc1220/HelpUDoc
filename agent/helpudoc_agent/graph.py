"""Agent graph construction utilities."""
from __future__ import annotations

from copy import deepcopy
import json
import logging
from typing import Any, Dict, Tuple

from deepagents.backends import FilesystemBackend
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware, TodoListMiddleware
from langchain.agents.middleware.summarization import SummarizationMiddleware
from langgraph.checkpoint.memory import MemorySaver
from langchain.chat_models import init_chat_model

from .configuration import Settings
from .state import WorkspaceState, AgentRuntimeState
from .tools_and_schemas import ToolFactory
from .skills_registry import (
    collect_tool_names,
    get_candidate_mcp_servers,
    load_skills,
    sync_skills_to_workspace,
)
from .mcp_manager import MCPServerManager
from .tool_guard import GuardedTool

logger = logging.getLogger(__name__)

GENERAL_SYSTEM_PROMPT = (
    "You are a general assistant. Use skills for specialized tasks. "
    "Apply progressive disclosure: call list_skills to discover relevant skills, "
    "then load_skill for only the matching SKILL.md and follow its instructions. "
    "If tools are listed in a skill frontmatter, use only those tools while executing that skill; "
    "if no tools are listed, you may use any appropriate tools. "
    "Once a skill is loaded, stay within that skill's workflow until its completion criteria are met "
    "(for example: report requests should end with the report artifact tool, dashboard requests should end with the dashboard tool). "
    "Do not assume skills are copied into the workspace. "
    "For proposal/SOW/RFP requests, always load the proposal-writing skill and write "
    "the proposal to workspace markdown files using write_file (and append_to_report if needed). "
    "Only call request_plan_approval when the loaded skill explicitly requires a plan review checkpoint or the active skill policy says requires_hitl_plan=true. "
    "If execution is blocked on missing user intent or an unresolved choice, call request_clarification instead of guessing. "
    "When a loaded skill says AskUserQuestion, asks for approval, or asks the human to pick among named options, "
    "you must use request_clarification or request_human_action with structured payloads instead of plain chat prose. "
    "For multi-question forms, populate questions_json. For chooser steps, populate options_json or actions_json with explicit labels, values, and descriptions. "
    "If you need the human to choose from arbitrary next-step actions, call request_human_action. "
    "After calling request_clarification or request_human_action, stop and wait for the resume payload. "
    "Do not continue to later phases, generate previews, or write additional artifacts until the interrupt has been answered. "
    "Only proceed with side-effecting tools after approval (or after applying user edits). "
    "Reply in chat with brief status updates, not full sections. "
    "If no skill applies, proceed with best-effort behavior."
)

BASE_AGENT_PROMPT = "In order to complete the objective that the user asks of you, you have access to a number of standard tools."


class AgentRegistry:
    """Caches DeepAgents keyed by (agent_name, workspace_id)."""

    def __init__(self, settings: Settings, tool_factory: ToolFactory):
        self.settings = settings
        self.tool_factory = tool_factory
        self._models: Dict[str, object] = {}
        self._checkpointer = MemorySaver()
        self._cache: Dict[Tuple[str, str, str], AgentRuntimeState] = {}
        self._default_agent_name = "general-assistant"

    def _resolve_mode(self, agent_name: str) -> str:
        name = (agent_name or "").strip().lower()
        if name.endswith(":pro") or name.endswith("-pro"):
            return "pro"
        if name.endswith(":lite") or name.endswith("-lite"):
            return "lite"
        if name.endswith(":fast") or name.endswith("-fast"):
            return "fast"
        if name in {"pro", "gemini-pro", "general-assistant-pro"}:
            return "pro"
        if name in {"lite", "gemini-lite", "general-assistant-lite", "flash-lite"}:
            return "lite"
        if name in {"fast", "flash", "general-assistant"}:
            return "fast"
        return "fast"

    def _get_model(self, model_name: str):
        model = self._models.get(model_name)
        if model is not None:
            return model
        cfg = self.settings.model
        if cfg.use_vertex_ai:
            model = init_chat_model(
                model_name,
                model_provider="google_vertex_ai",
                project=cfg.project,
                location=cfg.location,
            )
        else:
            # Force public Gemini (API key) path to avoid accidental Vertex calls.
            model = init_chat_model(
                model_name,
                model_provider="google_genai",
                api_key=cfg.api_key,
            )
        self._models[model_name] = model
        return model

    def _resolve_candidate_mcp_servers(self, workspace_state: WorkspaceState) -> list[str]:
        """Resolve MCP bind candidates from active skill scope and /mcp preference.

        Order is deterministic:
        1) skill-derived candidates
        2) explicit preferred MCP server (if configured and not already present)
        """
        active_skill = workspace_state.context.get("active_skill_scope")
        skill_candidates = list(get_candidate_mcp_servers(active_skill))

        preferred = workspace_state.context.get("preferred_mcp_server")
        preferred_server = str(preferred).strip() if isinstance(preferred, str) else ""
        candidates: list[str] = []
        seen: set[str] = set()
        for server_name in skill_candidates:
            normalized = str(server_name).strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            candidates.append(normalized)

        if preferred_server:
            if preferred_server in self.settings.mcp_servers:
                if preferred_server not in seen:
                    candidates.append(preferred_server)
            else:
                logger.warning(
                    "Ignoring preferred MCP server not present in runtime config (workspace=%s preferred=%s)",
                    workspace_state.workspace_id,
                    preferred_server,
                )

        logger.info(
            "MCP bind candidates resolved (workspace=%s preferred=%s allowed_by_skill=%s final_candidates=%s)",
            workspace_state.workspace_id,
            preferred_server or None,
            skill_candidates,
            candidates,
        )
        return candidates

    async def get_or_create(
        self,
        agent_name: str,
        workspace_id: str,
        initial_context: Dict[str, Any] | None = None,
    ) -> AgentRuntimeState:
        mode = self._resolve_mode(agent_name)
        model_name = self.settings.model.resolve_chat_model_name(mode)
        resolved_name = f"{self._default_agent_name}:{mode}"
        context_payload = initial_context or {}
        policy_key = json.dumps(context_payload.get("mcp_policy", {}) or {}, sort_keys=True, default=str)
        mcp_auth_fingerprint = str(context_payload.get("mcp_auth_fingerprint") or "")
        preferred_mcp_server = str(context_payload.get("preferred_mcp_server") or "").strip()
        user_key = str(context_payload.get("user_id") or "")
        cache_scope_prefix = f"{user_key}:{policy_key}:"
        key = (
            resolved_name,
            workspace_id,
            f"{user_key}:{policy_key}:{mcp_auth_fingerprint}:{preferred_mcp_server}",
        )
        if key in self._cache:
            runtime = self._cache[key]
            if context_payload:
                runtime.workspace_state.context.update(context_payload)
            return runtime
        preserved_context: Dict[str, Any] = {}
        # Prevent unbounded growth when delegated auth fingerprints rotate over time.
        stale_keys = [
            cache_key
            for cache_key in self._cache.keys()
            if cache_key[0] == resolved_name
            and cache_key[1] == workspace_id
            and str(cache_key[2]).startswith(cache_scope_prefix)
            and cache_key != key
        ]
        for stale_key in stale_keys:
            stale_runtime = self._cache.pop(stale_key, None)
            if stale_runtime is not None:
                # Preserve in-flight thread/skill state when delegated auth refreshes.
                preserved_context = deepcopy(stale_runtime.workspace_state.context)

        workspace_base = self.settings.backend.workspace_root
        workspace_base.mkdir(parents=True, exist_ok=True)
        workspace_root = workspace_base / workspace_id
        workspace_root.mkdir(parents=True, exist_ok=True)
        workspace_state = WorkspaceState(workspace_id=workspace_id, root_path=workspace_root)
        if preserved_context:
            workspace_state.context.update(preserved_context)
        if context_payload:
            workspace_state.context.update(context_payload)
        system_prompt = GENERAL_SYSTEM_PROMPT
        skills_root = self.settings.backend.skills_root
        if skills_root is not None:
            skills_root.mkdir(parents=True, exist_ok=True)
            if self.settings.backend.sync_skills_to_workspace:
                sync_skills_to_workspace(skills_root, workspace_state.root_path)
        skills = load_skills(skills_root) if skills_root is not None else []
        tool_names = collect_tool_names(skills)
        if tool_names:
            tool_names = [name for name in tool_names if name in self.settings.tools]
        if not tool_names:
            tool_names = list(self.settings.tools.keys())
        else:
            if "load_skill" in self.settings.tools and "load_skill" not in tool_names:
                tool_names.append("load_skill")
            if "list_skills" in self.settings.tools and "list_skills" not in tool_names:
                tool_names.append("list_skills")
        allow_script_runner = bool(context_payload.get("allow_script_runner") or context_payload.get("allowScriptRunner"))
        if allow_script_runner and "run_skill_python_script" in self.settings.tools and "run_skill_python_script" not in tool_names:
            tool_names.append("run_skill_python_script")

        builtin_tools = [
            GuardedTool.from_tool(tool, workspace_state=workspace_state)
            for tool in self.tool_factory.build_tools(tool_names, workspace_state)
        ]

        candidate_mcp_servers = self._resolve_candidate_mcp_servers(workspace_state)
        mcp_manager = MCPServerManager(self.settings, workspace_state)
        await mcp_manager.initialize(
            candidate_server_names=candidate_mcp_servers,
            preflight_gemini=self.settings.model.provider == "gemini",
        )
        preferred_server = workspace_state.context.get("preferred_mcp_server")
        normalized_preferred = str(preferred_server).strip() if isinstance(preferred_server, str) else ""
        bound_servers = list(mcp_manager.get_tools_by_server().keys())
        workspace_state.context["preferred_mcp_server_bound"] = bool(
            normalized_preferred and normalized_preferred in bound_servers
        )
        mcp_tools = []
        for server_name, server_tools in mcp_manager.get_tools_by_server().items():
            for tool in server_tools:
                mcp_tools.append(
                    GuardedTool.from_tool(
                        tool,
                        workspace_state=workspace_state,
                        tool_mcp_server=server_name,
                    )
                )

        logger.info(
            "MCP bind results (workspace=%s allowed_by_rbac=%s accepted=%s rejected=%s)",
            workspace_id,
            mcp_manager.get_allowed_server_names(),
            list(mcp_manager.get_tools_by_server().keys()),
            mcp_manager.get_rejected_servers(),
        )
        tools = builtin_tools + mcp_tools
        backend = FilesystemBackend(
            root_dir=str(workspace_state.root_path),
            virtual_mode=self.settings.backend.virtual_mode,
        )

        model = self._get_model(model_name)
        interrupt_on = dict(self.settings.backend.interrupt_on or {})
        if bool(context_payload.get("skip_plan_approvals") or context_payload.get("skipPlanApprovals")):
            interrupt_on.pop("request_plan_approval", None)

        middleware = [
            TodoListMiddleware(),
            FilesystemMiddleware(backend=backend),
            SummarizationMiddleware(
                model=model,
                max_tokens_before_summary=170000,
                messages_to_keep=6,
            ),
            PatchToolCallsMiddleware(),
        ]
        if interrupt_on:
            middleware.append(HumanInTheLoopMiddleware(interrupt_on=interrupt_on))

        full_prompt = system_prompt + "\n\n" + BASE_AGENT_PROMPT if system_prompt else BASE_AGENT_PROMPT
        agent = create_agent(
            model=model,
            tools=tools,
            system_prompt=full_prompt,
            middleware=middleware,
            checkpointer=self._checkpointer,
        ).with_config({"recursion_limit": 1000})

        runtime = AgentRuntimeState(agent_name=resolved_name, workspace_state=workspace_state, agent=agent)
        self._cache[key] = runtime
        return runtime
