from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))

from helpudoc_agent.config.env import reset_agent_env_caches_for_tests  # noqa: E402
from helpudoc_agent.configuration import load_settings  # noqa: E402
from helpudoc_agent.skills_registry import (  # noqa: E402
    collect_tool_names,
    is_tool_allowed,
    load_skills,
)


def test_workspace_root_env_override_resolves_from_repo_root(monkeypatch) -> None:
    repo_root = Path(__file__).resolve().parents[1]

    monkeypatch.chdir(repo_root)
    monkeypatch.setenv("WORKSPACE_ROOT", "backend/workspaces")
    monkeypatch.setenv("SKILLS_ROOT", "skills")
    monkeypatch.setenv("PLUGINS_ROOT", "plugins")

    settings = load_settings()

    assert settings.backend.workspace_root == (repo_root / "backend" / "workspaces").resolve()
    assert settings.backend.skills_root == (repo_root / "skills").resolve()
    assert settings.backend.plugins_root == (repo_root / "plugins").resolve()


def test_workspace_root_defaults_to_runtime_yaml_repo_relative_path(monkeypatch) -> None:
    repo_root = Path(__file__).resolve().parents[1]

    monkeypatch.chdir(repo_root)
    monkeypatch.delenv("WORKSPACE_ROOT", raising=False)
    monkeypatch.delenv("SKILLS_ROOT", raising=False)
    monkeypatch.delenv("PLUGINS_ROOT", raising=False)

    settings = load_settings()

    assert settings.backend.workspace_root == (repo_root / "backend" / "workspaces").resolve()
    assert settings.backend.plugins_root == (repo_root / "plugins").resolve()


def test_direct_office_is_not_a_programmatic_tool_call() -> None:
    settings = load_settings()

    assert "document_execute" not in settings.backend.code_interpreter.ptc_tools


def test_image_generation_tool_uses_provider_neutral_runtime_name() -> None:
    settings = load_settings()

    assert settings.get_tool("image_generation").name == "image_generation"
    assert "gemini_image" not in settings.tools


def test_execution_tools_require_explicit_skill_declarations() -> None:
    restrictive_scope = {"skill_id": "demo", "tools": ["inspect_document"]}

    assert not is_tool_allowed("document_execute", restrictive_scope)
    assert not is_tool_allowed("run_skill_python_script", restrictive_scope)
    assert not is_tool_allowed("append_to_report", restrictive_scope)

    document_scope = {
        "skill_id": "docx",
        "tools": ["document_execute", "run_skill_python_script"],
        "allow_unlisted_tools": True,
    }
    assert is_tool_allowed("document_execute", document_scope)
    assert is_tool_allowed("run_skill_python_script", document_scope)
    assert is_tool_allowed("append_to_report", document_scope)


def test_document_skills_bind_and_authorize_direct_office_tool() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    skills = load_skills(repo_root / "skills")
    by_id = {skill.skill_id: skill for skill in skills}

    assert "document_execute" in collect_tool_names(skills)
    for skill_id in ("docx", "pptx", "xlsx"):
        skill = by_id[skill_id]
        assert "document_execute" in skill.tools
        assert "run_skill_python_script" in skill.tools
        assert is_tool_allowed("document_execute", skill)
        assert is_tool_allowed("run_skill_python_script", skill)

    assert by_id["docx"].allow_unlisted_tools is True
    assert by_id["pptx"].allow_unlisted_tools is True
    assert by_id["xlsx"].allow_unlisted_tools is False


def _clear_vertex_env(monkeypatch) -> None:
    for name in ("GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"):
        monkeypatch.delenv(name, raising=False)


def test_vertex_env_vars_override_model_block(monkeypatch) -> None:
    """A ConfigMap must outrank runtime.yaml.

    On GKE runtime.yaml is served from agent-config-pvc and its seed init
    container skips a populated volume, so the file on disk is of unknown
    vintage. The env override is what makes the setting reachable at all.
    """
    monkeypatch.chdir(Path(__file__).resolve().parents[1])
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "override-proj")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "asia-southeast1")
    reset_agent_env_caches_for_tests()
    try:
        settings = load_settings()
        assert settings.model.use_vertex_ai is True
        assert settings.model.project == "override-proj"
        assert settings.model.location == "asia-southeast1"
    finally:
        reset_agent_env_caches_for_tests()


def test_explicit_false_overrides_vertex_in_runtime_yaml(monkeypatch) -> None:
    """The rollback lever: an explicit false must beat use_vertex_ai: true."""
    monkeypatch.chdir(Path(__file__).resolve().parents[1])
    _clear_vertex_env(monkeypatch)
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "false")
    reset_agent_env_caches_for_tests()
    try:
        assert load_settings().model.use_vertex_ai is False
    finally:
        reset_agent_env_caches_for_tests()


def test_absent_vertex_env_keeps_runtime_yaml_value(monkeypatch) -> None:
    """Unset must mean "do not override", not "false"."""
    monkeypatch.chdir(Path(__file__).resolve().parents[1])
    _clear_vertex_env(monkeypatch)
    reset_agent_env_caches_for_tests()
    try:
        settings = load_settings()
        assert settings.model.use_vertex_ai is True
        assert settings.model.location == "asia-southeast1"
    finally:
        reset_agent_env_caches_for_tests()


def test_unexpanded_api_key_placeholder_is_not_used_as_a_key(monkeypatch) -> None:
    """os.path.expandvars leaves an unset ${VAR} literal, which is truthy."""
    from helpudoc_agent.configuration import ModelConfig

    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    reset_agent_env_caches_for_tests()
    try:
        assert ModelConfig(name="m", api_key="${GEMINI_API_KEY}").api_key is None
        monkeypatch.setenv("GEMINI_API_KEY", "real-key")
        reset_agent_env_caches_for_tests()
        assert ModelConfig(name="m", api_key="${GEMINI_API_KEY}").api_key == "real-key"
        assert ModelConfig(name="m", api_key="sk-real").api_key == "sk-real"
    finally:
        reset_agent_env_caches_for_tests()
