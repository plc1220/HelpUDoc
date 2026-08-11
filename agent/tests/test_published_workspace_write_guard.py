from langchain_core.tools import tool

from helpudoc_agent.runtime.agent_registry import SkillScopedFilesystemBackend
from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tool_guard import GuardedTool


def _workspace(tmp_path, *, published: bool) -> WorkspaceState:
    state = WorkspaceState(workspace_id="guard-test", root_path=tmp_path)
    state.context.update(
        {
            "workspace_mode": "published_read_only" if published else "private",
            "can_write_workspace": not published,
        }
    )
    return state


def test_published_filesystem_allows_reads_but_blocks_writes(tmp_path):
    existing = tmp_path / "source.md"
    existing.write_text("Published content", encoding="utf-8")
    backend = SkillScopedFilesystemBackend(
        workspace_state=_workspace(tmp_path, published=True),
        root_dir=str(tmp_path),
        virtual_mode=True,
    )

    assert backend.read("/source.md").file_data
    assert "published workspace" in (backend.write("/new.md", "draft").error or "").lower()
    assert "published workspace" in (
        backend.edit("/source.md", "Published", "Changed").error or ""
    ).lower()
    assert existing.read_text(encoding="utf-8") == "Published content"
    assert not (tmp_path / "new.md").exists()


def test_published_runtime_blocks_workspace_mutating_builtin(tmp_path):
    @tool
    def append_to_report(source_path: str) -> str:
        """Append a source document to the report."""
        return f"appended {source_path}"

    guarded = GuardedTool.from_tool(
        append_to_report,
        workspace_state=_workspace(tmp_path, published=True),
    )

    result = guarded.invoke({"source_path": "/section.md"})

    assert isinstance(result, str)
    assert "cannot write into a published workspace" in result.lower()


def test_private_runtime_keeps_workspace_writes_enabled(tmp_path):
    @tool
    def append_to_report(source_path: str) -> str:
        """Append a source document to the report."""
        return f"appended {source_path}"

    guarded = GuardedTool.from_tool(
        append_to_report,
        workspace_state=_workspace(tmp_path, published=False),
    )

    assert guarded.invoke({"source_path": "/section.md"}) == "appended /section.md"


def test_research_final_report_requires_verified_search_sources(tmp_path):
    workspace = _workspace(tmp_path, published=False)
    workspace.context["active_skill"] = "research"
    backend = SkillScopedFilesystemBackend(
        workspace_state=workspace,
        root_dir=str(tmp_path),
        virtual_mode=True,
    )

    blocked = backend.write("/final-research-report.md", "Ungrounded report")
    assert "no verified google search sources" in (blocked.error or "").lower()
    assert not (tmp_path / "final-research-report.md").exists()

    workspace.context["google_search_source_count"] = 1
    allowed = backend.write("/final-research-report.md", "Grounded report")
    assert allowed.error is None
    assert (tmp_path / "final-research-report.md").read_text(encoding="utf-8") == "Grounded report"
