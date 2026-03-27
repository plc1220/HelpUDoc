from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))

from helpudoc_agent.configuration import load_settings  # noqa: E402


def test_env_override_paths_resolve_from_current_working_directory(monkeypatch) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    agent_root = repo_root / "agent"

    monkeypatch.chdir(agent_root)
    monkeypatch.setenv("WORKSPACE_ROOT", "../backend/workspaces")
    monkeypatch.setenv("SKILLS_ROOT", "../skills")

    settings = load_settings()

    assert settings.backend.workspace_root == (repo_root / "backend" / "workspaces").resolve()
    assert settings.backend.skills_root == (repo_root / "skills").resolve()
