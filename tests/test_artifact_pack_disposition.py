"""A run decides, with the human, what happens to an artifact pack already present.

A workspace directory is shared and a skill writes its pack to fixed paths, so a
run used to inherit an earlier run's artifacts as its own starting state. The
disposition rides along with the plan the human already approves.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from helpudoc_agent.artifact_pack import (
    CONTINUE,
    REPLACE,
    ProtectedPackError,
    archive_existing_pack,
    declared_pack_paths,
    detect_existing_pack,
    pack_disposition,
    set_pack_disposition,
)
from helpudoc_agent.runtime.agent_registry import SkillScopedFilesystemBackend
from helpudoc_agent.state import WorkspaceState

PACK = ["/final-research-report.md", "/research_notes.md", "/synthesis.md"]


def _workspace(tmp_path, *, run="run-1", protected=()) -> WorkspaceState:
    state = WorkspaceState(workspace_id="ws", root_path=tmp_path / "ws")
    state.context.update({
        "active_skill": "research",
        "active_skill_policy": {
            "requires_workspace_artifacts": True,
            "required_artifacts": PACK + ["pattern:charts/*.png"],
        },
        "run_id": run,
        "user_id": "alice",
        "protected_file_paths": list(protected),
    })
    return state


def _write_pack(state: WorkspaceState, text: str = "earlier run's work\n") -> None:
    for item in PACK:
        (state.root_path / item.lstrip("/")).write_text(text)


def test_pattern_entries_are_not_treated_as_files(tmp_path):
    """A `pattern:` entry describes a shape, so it names nothing to archive."""
    state = _workspace(tmp_path)
    assert declared_pack_paths(state.context) == [i.lstrip("/") for i in PACK]


def test_no_pack_detected_in_a_clean_workspace(tmp_path):
    assert detect_existing_pack(_workspace(tmp_path)) is None


def test_pack_is_detected_with_a_count_and_age(tmp_path):
    state = _workspace(tmp_path)
    _write_pack(state)
    pack = detect_existing_pack(state)
    assert pack is not None and pack.count == 3
    assert pack.newest_mtime != "unknown"


def test_replace_moves_the_pack_out_of_the_agents_view(tmp_path):
    state = _workspace(tmp_path)
    _write_pack(state, "# Top Comedy Movies\n")

    moved = archive_existing_pack(state, "run-1")

    assert sorted(moved) == sorted(i.lstrip("/") for i in PACK)
    for item in PACK:
        assert not (state.root_path / item.lstrip("/")).exists()

    backend = SkillScopedFilesystemBackend(
        workspace_state=state, root_dir=str(state.root_path), virtual_mode=True
    )
    listed = [e.get("path") for e in (backend.ls("/").entries or [])]
    assert not any(".system" in str(p) for p in listed), "the archive must be invisible"
    globbed = [m.get("path") for m in (backend.glob("**/*.md").matches or [])]
    assert globbed == [], "an archived report must not be reachable by glob"


def test_replace_refuses_to_move_signed_off_files(tmp_path):
    """Moving approved or published work is worse than refusing to start."""
    state = _workspace(tmp_path, protected=["final-research-report.md"])
    _write_pack(state)

    with pytest.raises(ProtectedPackError) as excinfo:
        archive_existing_pack(state, "run-1")

    assert "final-research-report.md" in str(excinfo.value)
    for item in PACK:
        assert (state.root_path / item.lstrip("/")).exists(), "nothing may be moved"


def test_archive_is_recorded_so_a_second_approval_does_not_rerun_it(tmp_path):
    from helpudoc_agent.artifact_pack import already_archived_for_run

    state = _workspace(tmp_path)
    _write_pack(state)
    archive_existing_pack(state, "run-1")

    assert already_archived_for_run(state.context, "run-1")
    assert not already_archived_for_run(state.context, "run-2")


def test_continue_leaves_the_pack_in_place(tmp_path):
    state = _workspace(tmp_path)
    _write_pack(state)
    set_pack_disposition(state, CONTINUE)

    assert pack_disposition(state.context) == CONTINUE
    for item in PACK:
        assert (state.root_path / item.lstrip("/")).exists()


def test_plan_approval_refuses_until_a_disposition_is_given(tmp_path, monkeypatch):
    """Option E: the model cannot proceed without putting the choice to the human."""
    from helpudoc_agent.tools.workspace.builtins import human_interrupts

    state = _workspace(tmp_path)
    _write_pack(state)

    def _must_not_interrupt(*args, **kwargs):
        raise AssertionError("must not reach the human without a disposition")

    monkeypatch.setattr(human_interrupts, "interrupt_with_retry", _must_not_interrupt)
    tool = human_interrupts.build_request_plan_approval_tool(state)

    result = tool.invoke({
        "plan_title": "Research CloudMile",
        "plan_summary": "Gather sources and write the report.",
        "execution_checklist": "1. search 2. write",
    })

    assert "PLAN_APPROVAL_NEEDS_PACK_DISPOSITION" in result
    assert "final-research-report.md" in result


def test_approving_a_replace_plan_archives_and_a_continue_plan_does_not(tmp_path, monkeypatch):
    from helpudoc_agent.tools.workspace.builtins import human_interrupts

    for disposition, should_exist in ((REPLACE, False), (CONTINUE, True)):
        state = _workspace(tmp_path / disposition)
        _write_pack(state)
        monkeypatch.setattr(
            human_interrupts,
            "interrupt_with_retry",
            lambda *a, **k: {"decisions": [{"type": "approve"}]},
        )
        tool = human_interrupts.build_request_plan_approval_tool(state)

        result = tool.invoke({
            "plan_title": "Research CloudMile",
            "plan_summary": "Gather sources and write the report.",
            "execution_checklist": "1. search 2. write",
            "pack_disposition": disposition,
        })

        assert "PLAN_APPROVAL_RECORDED" in result
        assert pack_disposition(state.context) == disposition
        assert (state.root_path / "final-research-report.md").exists() is should_exist


def test_a_rejected_plan_never_moves_anyones_files(tmp_path, monkeypatch):
    from helpudoc_agent.tools.workspace.builtins import human_interrupts

    state = _workspace(tmp_path)
    _write_pack(state)
    monkeypatch.setattr(
        human_interrupts,
        "interrupt_with_retry",
        lambda *a, **k: {"decisions": [{"type": "reject", "message": "wrong topic"}]},
    )
    tool = human_interrupts.build_request_plan_approval_tool(state)

    result = tool.invoke({
        "plan_title": "Research CloudMile",
        "plan_summary": "Gather sources.",
        "execution_checklist": "1. search",
        "pack_disposition": REPLACE,
    })

    assert "PLAN_REJECTION_RECORDED" in result
    for item in PACK:
        assert (state.root_path / item.lstrip("/")).exists(), "a refused plan archives nothing"


def test_trusted_mode_keeps_the_pack_because_nobody_was_asked(tmp_path, monkeypatch):
    from helpudoc_agent.tools.workspace.builtins import human_interrupts

    state = _workspace(tmp_path)
    state.context["skip_plan_approvals"] = True
    _write_pack(state)
    monkeypatch.setattr(
        human_interrupts,
        "interrupt_with_retry",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("trusted mode must not interrupt")),
    )
    tool = human_interrupts.build_request_plan_approval_tool(state)

    result = tool.invoke({
        "plan_title": "Research CloudMile",
        "plan_summary": "Gather sources.",
        "execution_checklist": "1. search",
        "pack_disposition": REPLACE,
    })

    assert "PLAN_APPROVAL_SKIPPED_TRUSTED_MODE" in result
    assert pack_disposition(state.context) == CONTINUE
    for item in PACK:
        assert (state.root_path / item.lstrip("/")).exists()
