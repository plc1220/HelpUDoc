"""A run must not be credited for artifacts an earlier run left behind.

Every user in a workspace shares one directory and the research skill writes
fifteen fixed paths into it, so "the file exists" cannot show that this run wrote
it. Reported, never fatal: a turn that reviews or answers questions about an
existing pack legitimately writes nothing, and failing it would block the
collaboration the workspace exists for.
"""
from __future__ import annotations

import time

WORKSPACE = "shared-workspace"


def test_required_artifacts_left_by_an_earlier_run_are_not_this_runs_output(tmp_path):
    """The check that credits a run for its artifacts must look at what it wrote.

    This mirrors `_unproduced_required_artifacts`, which is nested inside
    `register_chat_routes` and cannot be imported.
    """
    root = tmp_path / WORKSPACE
    root.mkdir(parents=True, exist_ok=True)
    required = ["/final-research-report.md", "/research_notes.md"]

    # Bob's earlier run leaves its artifacts at the skill's fixed paths.
    for item in required:
        (root / item.lstrip("/")).write_text("# Top Comedy Movies of 2026\n")

    time.sleep(0.01)
    baseline_ns = time.time_ns()  # Alice's turn starts here and writes nothing.

    existing = [i for i in required if (root / i.lstrip("/")).exists()]
    assert existing == required, "the bare existence check passes on Bob's files"

    stale = [
        i for i in required
        if (root / i.lstrip("/")).stat().st_mtime_ns < baseline_ns
    ]
    assert stale == required, "none of them were produced by Alice's run"


def _unproduced(root, required, baseline_ns):
    """Mirrors `_unproduced_required_artifacts`, nested inside register_chat_routes."""
    produced, stale = [], []
    for item in required:
        path = root / item.lstrip("/")
        if not path.exists():
            continue
        (produced if path.stat().st_mtime_ns >= baseline_ns else stale).append(item)
    return stale if stale and not produced else []


def test_collaborator_revising_a_shared_report_is_not_flagged(tmp_path):
    """Two people working on one report is the point of a shared workspace.

    Bob adds a section to the report Alice started. He rewrites one artifact and
    leaves the rest of the pack alone; that must read as ordinary collaboration.
    """
    root = tmp_path / WORKSPACE
    root.mkdir(parents=True, exist_ok=True)
    required = ["/final-research-report.md", "/research_notes.md", "/synthesis.md"]
    for item in required:
        (root / item.lstrip("/")).write_text("alice's earlier pack\n")

    time.sleep(0.01)
    baseline_ns = time.time_ns()
    time.sleep(0.01)
    (root / "final-research-report.md").write_text("bob adds a pricing section\n")

    assert _unproduced(root, required, baseline_ns) == []


def test_a_review_turn_that_writes_nothing_is_reported_but_not_failed(tmp_path):
    """"Review the report and tell me what is weak" writes no artifact.

    It is still flagged, because the run was credited for a pack it did not write,
    but the caller treats the flag as a warning. Failing here would block the
    collaboration the workspace exists for, and `proposal-writing` has no plan gate
    to narrow the check with.
    """
    root = tmp_path / WORKSPACE
    root.mkdir(parents=True, exist_ok=True)
    required = ["/final-research-report.md", "/research_notes.md"]
    for item in required:
        (root / item.lstrip("/")).write_text("alice's pack\n")

    time.sleep(0.01)
    baseline_ns = time.time_ns()

    flagged = _unproduced(root, required, baseline_ns)
    assert flagged == required, "the condition is detected"
    # and the stream still completes -- see the `contract_warning` branch in chat.py


def test_a_run_that_revises_one_artifact_is_still_accepted(tmp_path):
    """A later turn may legitimately rewrite part of an existing pack.

    Rejecting every stale artifact would break that, so only a run that produced
    none of them is refused.
    """
    root = tmp_path / WORKSPACE
    root.mkdir(parents=True, exist_ok=True)
    required = ["/final-research-report.md", "/research_notes.md"]
    for item in required:
        (root / item.lstrip("/")).write_text("earlier\n")

    time.sleep(0.01)
    baseline_ns = time.time_ns()
    time.sleep(0.01)
    (root / "final-research-report.md").write_text("revised by this run\n")

    produced = [i for i in required if (root / i.lstrip("/")).stat().st_mtime_ns >= baseline_ns]
    stale = [i for i in required if (root / i.lstrip("/")).stat().st_mtime_ns < baseline_ns]

    assert produced, "this run wrote one of them"
    assert (stale if stale and not produced else []) == [], (
        "a run that produced something must not be rejected for the rest"
    )
