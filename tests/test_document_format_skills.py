from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "agent"))

from helpudoc_agent.skills_registry import load_skills  # noqa: E402


def test_document_format_skills_are_discoverable() -> None:
    skills = load_skills(REPO_ROOT / "skills")
    ids = {skill.skill_id for skill in skills}

    assert "pdf" in ids
    assert "docx" in ids
    assert "sheets" not in ids
    assert "xlsx" in ids
    assert "image" in ids
    assert "pptx" in ids
    assert "general" not in ids


def test_pptx_requests_route_to_pptx_not_frontend_slides() -> None:
    skills = {skill.skill_id: skill for skill in load_skills(REPO_ROOT / "skills")}
    pptx_description = skills["pptx"].description or ""
    frontend_description = skills["frontend-slides"].description or ""
    general_prompt = (REPO_ROOT / "agent" / "prompts" / "general" / "core.md").read_text(encoding="utf-8")
    runtime_prompt = (REPO_ROOT / "agent" / "helpudoc_agent" / "runtime" / "agent_registry.py").read_text(
        encoding="utf-8"
    )
    frontend_skill = (REPO_ROOT / "skills" / "frontend-slides" / "SKILL.md").read_text(encoding="utf-8")

    assert "This skill owns PPTX-related work" in pptx_description
    assert "do not route those requests to `frontend-slides`" in pptx_description
    assert "Do not use for `.ppt`, `.pptx`, PowerPoint, Google Slides" in frontend_description
    assert "load the `pptx` skill" in general_prompt
    assert "Do not load `frontend-slides` for PPTX-related work." in general_prompt
    assert "load the pptx skill" in runtime_prompt
    assert "Do not load frontend-slides for PPTX-related work." in runtime_prompt
    assert "Mode B: PowerPoint/PPTX/Google Slides/native deck request" in frontend_skill
    assert "stop using this skill and route to `pptx`" in frontend_skill


def test_sales_asset_skill_routes_native_decks_to_pptx() -> None:
    content = (REPO_ROOT / "skills" / "sales" / "create-an-asset" / "SKILL.md").read_text(encoding="utf-8")

    assert "use `pptx` when the ask is specifically a PowerPoint" in content
    assert "use `frontend-slides` only when the ask is explicitly for a browser-native HTML/web presentation" in content


def test_sales_handoff_skills_route_native_decks_to_pptx() -> None:
    skill_paths = [
        REPO_ROOT / "skills" / "sales" / "call-prep" / "SKILL.md",
        REPO_ROOT / "skills" / "sales" / "call-summary" / "SKILL.md",
        REPO_ROOT / "skills" / "sales" / "competitive-intelligence" / "SKILL.md",
        REPO_ROOT / "skills" / "sales" / "draft-outreach" / "SKILL.md",
        REPO_ROOT / "skills" / "sales" / "create-an-asset" / "README.md",
    ]

    for path in skill_paths:
        content = path.read_text(encoding="utf-8")
        assert "`pptx`" in content, path
        assert "browser-native HTML/web presentation" in content, path


def test_proposal_writing_skill_declares_expected_mcp_servers() -> None:
    skills = {skill.skill_id: skill for skill in load_skills(REPO_ROOT / "skills")}

    assert skills["proposal-writing"].mcp_servers == [
        "aws-pricing",
        "aws-knowledge",
        "google-developer-knowledge",
        "gcp-cost",
    ]


def test_proposal_writing_skill_requires_quality_artifacts() -> None:
    skills = {skill.skill_id: skill for skill in load_skills(REPO_ROOT / "skills")}
    policy = skills["proposal-writing"].policy

    assert policy.requires_workspace_artifacts is True
    assert policy.required_artifacts_mode == "strict"
    assert policy.required_artifacts is not None
    assert "/proposal_quality_review.md" in policy.required_artifacts
    assert "/Final_Proposal.md" in policy.required_artifacts
