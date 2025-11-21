"""State containers for agents and workspaces."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict


@dataclass
class WorkspaceState:
    """Encapsulates workspace-specific derived paths."""

    workspace_id: str
    root_path: Path
    final_report_path: Path = field(init=False)
    question_path: Path = field(init=False)
    context: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.root_path.mkdir(parents=True, exist_ok=True)
        self.final_report_path = self.root_path / "final_report.md"
        self.question_path = self.root_path / "question.txt"


class AgentRuntimeState:
    """Holds runtime metadata for a workspace + agent pair."""

    def __init__(self, agent_name: str, workspace_state: WorkspaceState, agent=None):
        self.agent_name = agent_name
        self.workspace_state = workspace_state
        self.agent = agent

    @property
    def workspace_id(self) -> str:
        return self.workspace_state.workspace_id
