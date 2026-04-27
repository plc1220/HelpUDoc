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
    assert "sheets" in ids
    assert "image" in ids
    assert "pptx" in ids
    assert "general" not in ids


def test_proposal_writing_skill_declares_expected_mcp_servers() -> None:
    skills = {skill.skill_id: skill for skill in load_skills(REPO_ROOT / "skills")}

    assert skills["proposal-writing"].mcp_servers == [
        "aws-pricing",
        "aws-knowledge",
        "google-developer-knowledge",
        "gcp-cost",
    ]
