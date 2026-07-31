from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))

from helpudoc_agent.config.env import reset_agent_env_caches_for_tests  # noqa: E402
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


def test_vertex_env_vars_override_model_block(monkeypatch) -> None:
    repo_root = Path(__file__).resolve().parents[1]

    monkeypatch.chdir(repo_root)
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "override-proj")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "asia-southeast1")
    reset_agent_env_caches_for_tests()

    try:
        settings = load_settings()
        # ConfigMap env must win over the runtime.yaml (PVC-seeded) model block.
        assert settings.model.use_vertex_ai is True
        assert settings.model.project == "override-proj"
        assert settings.model.location == "asia-southeast1"
    finally:
        reset_agent_env_caches_for_tests()


def test_vertex_env_absent_keeps_runtime_yaml_defaults(monkeypatch) -> None:
    repo_root = Path(__file__).resolve().parents[1]

    monkeypatch.chdir(repo_root)
    monkeypatch.delenv("GOOGLE_GENAI_USE_VERTEXAI", raising=False)
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    monkeypatch.delenv("GOOGLE_CLOUD_LOCATION", raising=False)
    reset_agent_env_caches_for_tests()

    try:
        settings = load_settings()
        # runtime.yaml ships use_vertex_ai: false by default.
        assert settings.model.use_vertex_ai is False
    finally:
        reset_agent_env_caches_for_tests()
