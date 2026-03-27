from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
GRAPH_FILE = REPO_ROOT / "agent" / "helpudoc_agent" / "graph.py"
FRONTEND_SLIDES_SKILL = REPO_ROOT / "skills" / "frontend-slides" / "SKILL.md"


def test_general_prompt_requires_structured_interrupts_for_skill_questions() -> None:
    content = GRAPH_FILE.read_text(encoding="utf-8")
    assert "When a loaded skill says AskUserQuestion" in content
    assert "populate questions_json" in content
    assert "stop and wait for the resume payload" in content
    assert "Do not continue to later phases, generate previews, or write additional artifacts" in content


def test_frontend_slides_skill_requires_request_clarification_at_gating_steps() -> None:
    content = FRONTEND_SLIDES_SKILL.read_text(encoding="utf-8")
    assert "Use `request_clarification` for every decision gate in this skill." in content
    assert "single `request_clarification` call" in content
    assert "Show preset picker via a second `request_clarification` call" in content
    assert "Then use `request_clarification`:" in content
    assert "Do not generate the final presentation until the user has answered the style-selection interrupt." in content
