"""Agent graph construction utilities."""
from __future__ import annotations

from typing import Dict, Tuple

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from langchain.chat_models import init_chat_model

from .configuration import Settings
from .prompts import PromptStore
from .state import WorkspaceState, AgentRuntimeState
from .tools_and_schemas import ToolFactory


class AgentRegistry:
    """Caches DeepAgents keyed by (agent_name, workspace_id)."""

    def __init__(self, settings: Settings, prompt_store: PromptStore, tool_factory: ToolFactory):
        self.settings = settings
        self.prompt_store = prompt_store
        self.tool_factory = tool_factory
        self._model = None
        self._cache: Dict[Tuple[str, str], AgentRuntimeState] = {}

    def _init_model(self):
        if self._model is None:
            self._model = init_chat_model(model=self.settings.model.name)
        return self._model

    def get_or_create(self, agent_name: str, workspace_id: str) -> AgentRuntimeState:
        key = (agent_name, workspace_id)
        if key in self._cache:
            return self._cache[key]

        workspace_base = self.settings.backend.workspace_root
        workspace_base.mkdir(parents=True, exist_ok=True)
        workspace_root = workspace_base / workspace_id
        workspace_state = WorkspaceState(workspace_id=workspace_id, root_path=workspace_root)
        agent_config = self.settings.get_agent(agent_name)
        system_prompt = self.prompt_store.load(agent_config.system_prompt_id)
        tools = self.tool_factory.build_tools(agent_config.tools, workspace_state)
        subagents = []
        for sub in agent_config.subagents:
            sub_prompt = self.prompt_store.load(sub.system_prompt_id)
            sub_tools = self.tool_factory.build_tools(sub.tools, workspace_state)
            subagents.append({
                "name": sub.name,
                "description": sub.description,
                "system_prompt": sub_prompt,
                "tools": sub_tools,
            })

        backend = FilesystemBackend(
            root_dir=str(workspace_state.root_path),
            virtual_mode=self.settings.backend.virtual_mode,
        )

        agent = create_deep_agent(
            model=self._init_model(),
            backend=backend,
            tools=tools,
            system_prompt=system_prompt,
            subagents=subagents,
        )

        runtime = AgentRuntimeState(agent_name=agent_name, workspace_state=workspace_state, agent=agent)
        self._cache[key] = runtime
        return runtime
