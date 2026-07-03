from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
GENERAL_PROMPT_SOURCE = REPO_ROOT / "agent" / "helpudoc_agent" / "runtime" / "agent_registry.py"
FRONTEND_SLIDES_SKILL = REPO_ROOT / "skills" / "frontend-slides" / "SKILL.md"
HUMAN_INTERRUPTS = REPO_ROOT / "agent" / "helpudoc_agent" / "tools" / "workspace" / "builtins" / "human_interrupts.py"
A2UI_TOOL = REPO_ROOT / "agent" / "helpudoc_agent" / "tools" / "workspace" / "builtins" / "a2ui.py"
A2UI_CONTRACT = REPO_ROOT / "agent" / "helpudoc_agent" / "a2ui_contract.py"


def test_general_prompt_requires_structured_interrupts_for_skill_questions() -> None:
    content = GENERAL_PROMPT_SOURCE.read_text(encoding="utf-8")
    assert "When a loaded skill says AskUserQuestion" in content
    assert "populate questions_json" in content
    assert "stop and wait for the resume payload" in content
    assert "Do not continue to later phases, generate previews, or write additional artifacts" in content


def test_frontend_slides_skill_requires_workflow_action_at_gating_steps() -> None:
    content = FRONTEND_SLIDES_SKILL.read_text(encoding="utf-8")
    assert "Use `workflow_action(action=\"ask_user_a2ui\")` for every decision gate in this skill." in content
    assert "A UI form only exists when a structured workflow/A2UI tool emits an interrupt" in content
    assert "presentation_context" in content
    assert "outline_confirmation" in content
    assert "style_preview_selection" in content
    assert "Do not ask for `style_path_selection` or `mood_or_preset_selection` in new runs." in content
    assert ".frontend-slides/slide-previews/" in content
    assert "component=\"style.previewChooser\"" in content
    assert "final HTML deck exists" in content


def test_frontend_slides_skill_has_fixed_stage_and_pptx_export_contract() -> None:
    content = FRONTEND_SLIDES_SKILL.read_text(encoding="utf-8")
    assert "fixed 1920×1080 stage architecture" in content
    assert "viewport-base.css" in content
    assert "html-template.md" in content
    assert "scripts/export-pptx.py" in content
    assert "screenshot-backed" in content
    assert "not deeply editable PowerPoint shapes" in content


def test_a2ui_tools_record_generic_gate_completion_after_resume() -> None:
    workflow_content = A2UI_TOOL.read_text(encoding="utf-8")
    human_interrupts_content = HUMAN_INTERRUPTS.read_text(encoding="utf-8")
    contract_content = A2UI_CONTRACT.read_text(encoding="utf-8")

    assert "mark_gate_pending(" in workflow_content
    assert "mark_gate_completed(" in workflow_content
    assert "answersByQuestionId" in workflow_content
    assert "mark_gate_completed(" in human_interrupts_content
    assert "a2ui_gate_ledger" in contract_content
