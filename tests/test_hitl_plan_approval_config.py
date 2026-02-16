from pathlib import Path

from helpudoc_agent.configuration import load_settings
from helpudoc_agent.skills_registry import collect_tool_names, load_skills


def test_runtime_config_exposes_request_plan_approval_interrupt() -> None:
    settings = load_settings()

    interrupt_cfg = settings.backend.interrupt_on.get("request_plan_approval")
    assert isinstance(interrupt_cfg, dict)
    assert interrupt_cfg.get("allowed_decisions") == ["approve", "edit", "reject"]


def test_runtime_config_does_not_force_search_interrupts() -> None:
    settings = load_settings()
    assert "internet_search" not in settings.backend.interrupt_on
    assert "google_grounded_search" not in settings.backend.interrupt_on


def test_runtime_config_registers_request_plan_approval_tool() -> None:
    settings = load_settings()
    assert "request_plan_approval" in settings.tools


def test_collect_tool_names_adds_request_plan_approval_for_hitl_skills() -> None:
    skills = load_skills(Path("skills"))
    assert any(skill.skill_id == "research" and skill.policy.requires_hitl_plan for skill in skills)

    tool_names = collect_tool_names(skills)
    assert "request_plan_approval" in tool_names
