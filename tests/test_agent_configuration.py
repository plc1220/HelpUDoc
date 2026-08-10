from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))

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
