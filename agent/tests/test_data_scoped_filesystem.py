from __future__ import annotations

from pathlib import Path

from helpudoc_agent.runtime.agent_registry import SkillScopedFilesystemBackend
from helpudoc_agent.state import WorkspaceState


def test_data_skill_blocks_raw_structured_reads_but_allows_sandbox_results(tmp_path: Path) -> None:
    workspace = WorkspaceState(workspace_id="data-file-scope", root_path=tmp_path)
    workspace.context["active_skill"] = "data/analyze"
    workspace.context["_current_sandbox_run_ids"] = ["run-1"]
    (tmp_path / "orders.csv").write_text("order_id,revenue\nA,10.25\n", encoding="utf-8")
    result_dir = tmp_path / "sandbox-runs" / "run-1" / "out"
    result_dir.mkdir(parents=True)
    (result_dir / "result.json").write_text('{"rows":[{"total":10.25}]}', encoding="utf-8")

    backend = SkillScopedFilesystemBackend(
        workspace_state=workspace,
        root_dir=tmp_path,
        virtual_mode=True,
    )

    blocked = backend.read("/orders.csv")
    assert blocked.error
    assert "data_workspace" in blocked.error

    allowed = backend.read("/sandbox-runs/run-1/out/result.json")
    assert allowed.error is None
    assert allowed.file_data is not None
    assert "10.25" in allowed.file_data["content"]

    prior_dir = tmp_path / "sandbox-runs" / "prior-run" / "out"
    prior_dir.mkdir(parents=True)
    (prior_dir / "result.json").write_text('{"stale":true}', encoding="utf-8")
    prior = backend.read("/sandbox-runs/prior-run/out/result.json")
    assert prior.error
    assert "Prior sandbox artifact" in prior.error

    glob_paths = {
        str(match["path"])
        for match in backend.glob("**/*.json").matches or []
    }
    assert "/sandbox-runs/run-1/out/result.json" in glob_paths
    assert "/sandbox-runs/prior-run/out/result.json" not in glob_paths

    sandbox_entries = {
        str(entry["path"])
        for entry in backend.ls("/sandbox-runs").entries or []
    }
    assert "/sandbox-runs/run-1/" in sandbox_entries
    assert "/sandbox-runs/prior-run/" not in sandbox_entries

    money_matches = backend.grep("10.25").matches or []
    assert all(match["path"] != "/orders.csv" for match in money_matches)
    assert backend.grep("stale").matches == []

    report_dir = tmp_path / "reports"
    report_dir.mkdir()
    (report_dir / "stale.json").write_text('{"stale":true}', encoding="utf-8")
    stale_report = backend.read("/reports/stale.json")
    assert stale_report.error
    assert "Untagged prior artifact" in stale_report.error

    workspace.context["tagged_files"] = ["reports/stale.json"]
    tagged_report = backend.read("/reports/stale.json")
    assert tagged_report.error is None


def test_non_data_skill_can_read_structured_source(tmp_path: Path) -> None:
    workspace = WorkspaceState(workspace_id="general-file-scope", root_path=tmp_path)
    workspace.context["active_skill"] = "general"
    (tmp_path / "orders.csv").write_text("order_id,revenue\nA,10.25\n", encoding="utf-8")
    backend = SkillScopedFilesystemBackend(
        workspace_state=workspace,
        root_dir=tmp_path,
        virtual_mode=True,
    )

    result = backend.read("/orders.csv")
    assert result.error is None
    assert result.file_data is not None
