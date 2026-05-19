from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
GENERAL_PROMPT_SOURCE = REPO_ROOT / "agent" / "helpudoc_agent" / "runtime" / "agent_registry.py"
FRONTEND_SLIDES_SKILL = REPO_ROOT / "skills" / "frontend-slides" / "SKILL.md"


def test_general_prompt_requires_structured_interrupts_for_skill_questions() -> None:
    content = GENERAL_PROMPT_SOURCE.read_text(encoding="utf-8")
    assert "When a loaded skill says AskUserQuestion" in content
    assert "populate questions_json" in content
    assert "stop and wait for the resume payload" in content
    assert "Do not continue to later phases, generate previews, or write additional artifacts" in content


def test_frontend_slides_skill_requires_request_clarification_at_gating_steps() -> None:
    content = FRONTEND_SLIDES_SKILL.read_text(encoding="utf-8")
    assert "Use `request_clarification` for every decision gate in this skill." in content
    assert 'If you are about to write phrases like "select from the form above"' in content
    assert "A UI form only exists when this tool emits an interrupt" in content
    assert "single `request_clarification` call" in content
    assert "Show preset picker via a second `request_clarification` call" in content
    assert "Call `request_clarification` immediately at this step." in content
    assert 'submit_label="Generate style previews"' in content
    assert "Then use `request_clarification` with preview metadata" in content
    assert "thumbnail chooser window" in content
    assert '"chooser": "style-previews"' in content
    assert '"path": ".claude-design/slide-previews/style-a.html"' in content
    assert "Do not generate the final presentation until the user has answered the style-selection interrupt." in content
