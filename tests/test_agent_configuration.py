from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))

from helpudoc_agent.configuration import load_settings  # noqa: E402


def test_workspace_root_env_override_resolves_from_repo_root(monkeypatch) -> None:
    repo_root = Path(__file__).resolve().parents[1]

    monkeypatch.chdir(repo_root)
    monkeypatch.setenv("WORKSPACE_ROOT", "backend/workspaces")
    monkeypatch.setenv("SKILLS_ROOT", "skills")

    settings = load_settings()

    assert settings.backend.workspace_root == (repo_root / "backend" / "workspaces").resolve()
    assert settings.backend.skills_root == (repo_root / "skills").resolve()


def test_workspace_root_defaults_to_runtime_yaml_repo_relative_path(monkeypatch) -> None:
    repo_root = Path(__file__).resolve().parents[1]

    monkeypatch.chdir(repo_root)
    monkeypatch.delenv("WORKSPACE_ROOT", raising=False)
    monkeypatch.delenv("SKILLS_ROOT", raising=False)

    settings = load_settings()

    assert settings.backend.workspace_root == (repo_root / "backend" / "workspaces").resolve()
