"""The agent owns report formatting; the host only tracks which sources were verified.

`SourceTracker.update_final_report` used to rewrite the finished report to append a Sources
section. It was dead code: it looked for `final_report.md` while the research skill writes
`final-research-report.md`, so it returned at its first line on every run. Worse, the section it
would have written used an `h3` heading and appended *after* the report's trailing `Word Count`
section, contradicting the skill's required structure.

These tests pin what survived that removal:
  - the tracker still records verified sources, which the research source contract depends on;
  - no host-side method rewrites the report, so host and skill cannot disagree on format again;
  - the skill itself still requires the Sources section.
"""
from __future__ import annotations

from pathlib import Path

from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.utils import SourceTracker

RESEARCH_SKILL = Path(__file__).parent.parent / "skills" / "research" / "SKILL.md"


def test_tracker_records_and_lists_verified_sources(tmp_path: Path) -> None:
    """The research source contract reads list_sources to prove evidence was collected."""
    workspace = WorkspaceState("ws-1", tmp_path)
    tracker = SourceTracker()

    tracker.record(workspace, [
        {"title": "Primary", "url": "https://example.com/a"},
        {"title": "Secondary", "url": "https://example.com/b"},
    ])

    assert tracker.list_sources(workspace) == [
        (1, "Primary", "https://example.com/a"),
        (2, "Secondary", "https://example.com/b"),
    ]


def test_duplicate_urls_are_recorded_once(tmp_path: Path) -> None:
    workspace = WorkspaceState("ws-1", tmp_path)
    tracker = SourceTracker()

    tracker.record(workspace, [{"title": "A", "url": "https://example.com/a"}])
    tracker.record(workspace, [{"title": "A again", "url": "https://example.com/a"}])

    assert len(tracker.list_sources(workspace)) == 1


def test_reset_is_scoped_to_one_workspace(tmp_path: Path) -> None:
    first = WorkspaceState("ws-1", tmp_path / "a")
    second = WorkspaceState("ws-2", tmp_path / "b")
    tracker = SourceTracker()
    tracker.record(first, [{"title": "A", "url": "https://example.com/a"}])
    tracker.record(second, [{"title": "B", "url": "https://example.com/b"}])

    tracker.reset(first)

    assert tracker.list_sources(first) == []
    assert len(tracker.list_sources(second)) == 1


def test_tracker_cannot_rewrite_the_report() -> None:
    """Host-side report mutation must stay gone, or it will fight the skill's format again."""
    assert not hasattr(SourceTracker, "update_final_report")
    assert not hasattr(SourceTracker, "_linkify_numeric_citations")


def test_workspace_state_exposes_no_hardcoded_report_path(tmp_path: Path) -> None:
    """The report filename belongs to the skill, not to workspace state.

    `final_report_path` pointed at `final_report.md`, a filename no current skill writes.
    """
    workspace = WorkspaceState("ws-1", tmp_path)

    assert not hasattr(workspace, "final_report_path")
    assert not hasattr(workspace, "question_path")


def test_research_skill_still_owns_the_sources_section() -> None:
    """Removing host injection must not drop the requirement itself."""
    content = RESEARCH_SKILL.read_text(encoding="utf-8")

    assert "## Sources" in content
    assert "A Sources section" in content
    # Sources must precede the trailing Word Count section in the required structure.
    assert content.index("## Sources") < content.rindex("## Word Count")
