"""Agent graph construction utilities."""
from __future__ import annotations

import json
from typing import Any, Dict, Tuple

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from langgraph.checkpoint.memory import MemorySaver
from langchain.chat_models import init_chat_model

from .configuration import Settings
from .state import WorkspaceState, AgentRuntimeState
from .tools_and_schemas import ToolFactory
from .skills_registry import collect_tool_names, load_skills, sync_skills_to_workspace
from .mcp_manager import MCPServerManager

GENERAL_SYSTEM_PROMPT = (
    "You are a general assistant. Use skills for specialized tasks. "
    "Apply progressive disclosure: call list_skills to discover relevant skills, "
    "then load_skill for only the matching SKILL.md and follow its instructions. "
    "If tools are listed in a skill frontmatter, use only those tools while executing that skill; "
    "if no tools are listed, you may use any appropriate tools. "
    "Do not assume skills are copied into the workspace. "
    "For proposal/SOW/RFP requests, always load the proposal-writing skill and write "
    "the proposal to workspace markdown files using write_file (and append_to_report if needed). "
    "Reply in chat with brief status updates, not full sections. "
    "If no skill applies, proceed with best-effort behavior."
)


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
        if name.endswith(":fast") or name.endswith("-fast"):
            return "fast"
        if name in {"pro", "gemini-pro", "general-assistant-pro"}:
            return "pro"
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
        user_key = str(context_payload.get("user_id") or "")
        key = (resolved_name, workspace_id, f"{user_key}:{policy_key}")
        if key in self._cache:
            return self._cache[key]

        workspace_base = self.settings.backend.workspace_root
        workspace_base.mkdir(parents=True, exist_ok=True)
        workspace_root = workspace_base / workspace_id
        workspace_root.mkdir(parents=True, exist_ok=True)
        workspace_state = WorkspaceState(workspace_id=workspace_id, root_path=workspace_root)
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

        builtin_tools = self.tool_factory.build_tools(tool_names, workspace_state)

        mcp_manager = MCPServerManager(self.settings, workspace_state)
        await mcp_manager.initialize()
        mcp_tools = await mcp_manager.get_tools()

        tools = builtin_tools + mcp_tools
        subagents = []

        backend = FilesystemBackend(
            root_dir=str(workspace_state.root_path),
            virtual_mode=self.settings.backend.virtual_mode,
        )

        agent = create_deep_agent(
            model=self._get_model(model_name),
            backend=backend,
            tools=tools,
            system_prompt=system_prompt,
            subagents=subagents,
            interrupt_on=self.settings.backend.interrupt_on,
            checkpointer=self._checkpointer,
        )

        runtime = AgentRuntimeState(agent_name=resolved_name, workspace_state=workspace_state, agent=agent)
        self._cache[key] = runtime
        return runtime
