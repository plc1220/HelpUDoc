"""Collected sources belong to one run, not to the whole workspace.

`SourceTracker` is a single process-wide instance. Keyed by workspace alone, two
people working in one workspace shared a source list: one user's citations were
appended to the other's report, and the reset at the start of a turn wiped
evidence a concurrent run had already gathered.
"""
from __future__ import annotations

from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.utils import SourceTracker

WORKSPACE = "shared-workspace"


def _workspace(tmp_path, *, user: str, run: str | None) -> WorkspaceState:
    """Two users in one workspace resolve to the same directory by design."""
    state = WorkspaceState(workspace_id=WORKSPACE, root_path=tmp_path / WORKSPACE)
    state.context["user_id"] = user
    if run:
        state.context["run_id"] = run
    return state


def test_one_run_does_not_see_another_runs_sources(tmp_path):
    alice = _workspace(tmp_path, user="alice", run="run-alice")
    bob = _workspace(tmp_path, user="bob", run="run-bob")
    tracker = SourceTracker()

    tracker.record(bob, [{"url": "https://comedy.example/top-10", "title": "Top 10 Comedies"}])

    assert tracker.list_sources(bob), "the run that gathered them must keep them"
    assert tracker.list_sources(alice) == [], (
        "keyed by workspace alone, bob's citations were appended to alice's report"
    )


def test_a_new_turn_does_not_wipe_another_runs_sources(tmp_path):
    """`_reset_turn_context` resets the tracker at the start of every fresh turn.

    Workspace-keyed, that discarded evidence a concurrent run had already gathered,
    which then failed that run's research source contract for having no sources.
    """
    alice = _workspace(tmp_path, user="alice", run="run-alice")
    bob = _workspace(tmp_path, user="bob", run="run-bob")
    tracker = SourceTracker()
    tracker.record(bob, [{"url": "https://example.com/a", "title": "A"}])

    tracker.reset(alice)

    assert tracker.list_sources(bob), "alice starting a turn must not clear bob's run"


def test_sources_survive_a_resume_of_the_same_run(tmp_path):
    """An explicit resume keeps the run id, so plan approval keeps its evidence."""
    first = _workspace(tmp_path, user="alice", run="run-1")
    tracker = SourceTracker()
    tracker.record(first, [{"url": "https://example.com/a", "title": "A"}])

    resumed = _workspace(tmp_path, user="alice", run="run-1")
    assert len(tracker.list_sources(resumed)) == 1


def test_falls_back_to_the_user_when_no_run_id_is_supplied(tmp_path):
    """The direct /chat endpoint carries no run id; users must still not mix."""
    alice = _workspace(tmp_path, user="alice", run=None)
    bob = _workspace(tmp_path, user="bob", run=None)
    tracker = SourceTracker()

    tracker.record(bob, [{"url": "https://example.com/b", "title": "B"}])

    assert tracker.list_sources(alice) == []


def test_scope_table_is_bounded(tmp_path):
    """The key now includes a run id, so the table would otherwise grow forever."""
    from helpudoc_agent.utils import _MAX_TRACKED_SOURCE_SCOPES

    tracker = SourceTracker()
    for index in range(_MAX_TRACKED_SOURCE_SCOPES + 50):
        state = _workspace(tmp_path, user="alice", run=f"run-{index}")
        tracker.record(state, [{"url": f"https://example.com/{index}", "title": "T"}])

    assert len(tracker._sources) <= _MAX_TRACKED_SOURCE_SCOPES
