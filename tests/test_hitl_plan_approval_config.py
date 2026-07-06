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
    assert "google_search" not in settings.backend.interrupt_on


def test_runtime_config_registers_request_plan_approval_tool() -> None:
    settings = load_settings()
    assert "request_plan_approval" in settings.tools


def test_collect_tool_names_adds_request_plan_approval_for_hitl_skills() -> None:
    skills = load_skills(Path("skills"))
    assert any(skill.skill_id == "research" and skill.policy.requires_hitl_plan for skill in skills)

    tool_names = collect_tool_names(skills)
    assert "request_plan_approval" in tool_names


def test_research_skill_declares_its_own_artifact_contract() -> None:
    skills = {skill.skill_id: skill for skill in load_skills(Path("skills"))}
    research = skills["research"]

    assert research.policy.requires_hitl_plan is True
    assert research.policy.requires_workspace_artifacts is True
    assert research.policy.required_artifacts_mode == "full_pack"
    assert research.policy.pre_plan_search_limit == 3
    assert research.policy.required_artifacts == [
        "/question.txt",
        "/research_mode.md",
        "/entity_disambiguation.md",
        "/preliminary_search_notes.md",
        "/research_plan.md",
        "/source_register.md",
        "/research_notes.md",
        "/claim_evidence_matrix.md",
        "/contradictions_and_uncertainties.md",
        "/red_flags_and_exclusions.md",
        "/knowledge_graph.md",
        "/synthesis.md",
        "/final_report_audit.md",
        "/final_quality_check.md",
        "/final-research-report.md",
    ]


def test_dashboard_skill_requires_hitl_plan() -> None:
    skills = {skill.skill_id: skill for skill in load_skills(Path("skills"))}
    dashboard = skills["data/dashboard"]

    assert dashboard.policy.requires_hitl_plan is True
    assert "request_plan_approval" in dashboard.tools
