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


def test_general_skill_routes_binary_documents_to_format_skills() -> None:
    content = (REPO_ROOT / "skills" / "general" / "SKILL.md").read_text(encoding="utf-8")

    assert ".pdf" in content
    assert "-> `pdf`" in content
    assert "-> `image`" in content
    assert "-> `sheets`" in content
    assert "-> `pptx`" in content
    assert "Do not use `read_file` on common binary document formats" in content
