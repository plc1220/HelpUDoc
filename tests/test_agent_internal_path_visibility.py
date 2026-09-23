"""The agent must not see the storage the product manages on a user's behalf.

`.system/` holds immutable file versions, upload staging and the OKF knowledge
bundles an ingestion explodes a document into. The backend keeps it out of the
file browser, the artifact commit and the provenance trail
(`isInternalWorkspacePath`), but the agent had no equivalent rule, so it could
list and read every superseded version of every file in a shared workspace.
"""
from __future__ import annotations

from helpudoc_agent.runtime.agent_registry import SkillScopedFilesystemBackend
from helpudoc_agent.state import WorkspaceState


def _backend(tmp_path, *, skill="research"):
    state = WorkspaceState(workspace_id="ws", root_path=tmp_path / "ws")
    state.context.update({"active_skill": skill, "user_id": "alice"})
    root = state.root_path
    (root / ".system" / "versions" / "2").mkdir(parents=True, exist_ok=True)
    (root / ".system" / "versions" / "2" / "report.md").write_text("superseded draft\n")
    (root / "report.md").write_text("the current report\n")
    return state, SkillScopedFilesystemBackend(
        workspace_state=state, root_dir=str(root), virtual_mode=True
    )


def test_ls_does_not_reveal_internal_storage(tmp_path):
    _, backend = _backend(tmp_path)
    listed = [e.get("path") for e in (backend.ls("/").entries or [])]
    assert "/report.md" in listed, "ordinary documents stay visible"
    assert not any(".system" in str(item) for item in listed)


def test_ls_inside_internal_storage_returns_nothing(tmp_path):
    _, backend = _backend(tmp_path)
    assert (backend.ls("/.system/versions/2").entries or []) == []


def test_glob_does_not_reach_superseded_versions(tmp_path):
    _, backend = _backend(tmp_path)
    matches = [m.get("path") for m in (backend.glob("**/*.md").matches or [])]
    assert matches == ["/report.md"]


def test_read_is_refused_rather_than_returning_nothing(tmp_path):
    """An empty read would read to the model as "this file has no content"."""
    _, backend = _backend(tmp_path)
    result = backend.read("/.system/versions/2/report.md")
    assert getattr(result, "error", None), "must refuse, not return empty content"
    assert "report.md" in result.error


def test_write_into_internal_storage_is_refused(tmp_path):
    _, backend = _backend(tmp_path)
    result = backend.write("/.system/versions/2/planted.md", "x")
    assert getattr(result, "error", None)
    assert not (tmp_path / "ws" / ".system" / "versions" / "2" / "planted.md").exists()


def test_sandbox_runs_stays_visible(tmp_path):
    """Deliberately not hidden.

    The data skill reads its own current run's outputs through this backend and
    `_data_path_is_visible` already bounds that to the run's own ids. Hiding the
    directory outright would break it.
    """
    state, backend = _backend(tmp_path, skill="research")
    (state.root_path / "sandbox-runs" / "run-1").mkdir(parents=True, exist_ok=True)
    (state.root_path / "sandbox-runs" / "run-1" / "out.md").write_text("output\n")

    listed = [e.get("path") for e in (backend.ls("/").entries or [])]
    assert any("sandbox-runs" in str(item) for item in listed)


def test_get_image_url_does_not_walk_internal_storage(tmp_path):
    """This builtin walks `root_path` directly and bypasses the backend."""
    from helpudoc_agent.tools.workspace.builtins.workspace_files import (
        build_get_image_url_tool,
    )

    state, _ = _backend(tmp_path)
    (state.root_path / ".system" / "versions" / "2" / "secret.png").write_bytes(b"\x89PNG")

    tool = build_get_image_url_tool(state)
    result = str(tool.invoke({"file_name": "secret.png"}))

    assert ".system" not in result
