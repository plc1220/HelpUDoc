from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from helpudoc_agent.sandbox_runner import run_skill_python_script_locally
from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tools.workspace.builtins.skills import (
    _canonical_declared_script_name,
    _data_workspace_action,
    build_run_skill_python_script_tool,
)


def test_data_workspace_action_parses_both_supported_request_forms() -> None:
    assert _data_workspace_action(['{"action":"query"}']) == "query"
    assert _data_workspace_action(["--request-json", '{"action":"export"}']) == "export"
    assert _data_workspace_action(['{"action":"schema"}']) == "schema"


def test_declared_script_path_is_canonicalized_to_pinned_name(tmp_path: Path) -> None:
    workspace = WorkspaceState(workspace_id="script-name", root_path=tmp_path)
    workspace.context["active_skill_scope"] = {
        "sandbox_scripts": [{"name": "data_workspace"}]
    }
    assert (
        _canonical_declared_script_name(
            workspace,
            "/sandbox-runs/prior/scripts/data_workspace.py",
        )
        == "data_workspace"
    )
    assert _canonical_declared_script_name(workspace, "unknown.py") == "unknown.py"


def test_data_workspace_eleventh_query_is_blocked_before_execution(tmp_path: Path) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    workspace = WorkspaceState(workspace_id="data-query-limit", root_path=tmp_path)
    workspace.context["_data_workspace_query_executions"] = 10
    settings = SimpleNamespace(
        backend=SimpleNamespace(
            skills_root=repo_root / "skills",
            plugins_root=repo_root / "plugins",
        )
    )
    tool = build_run_skill_python_script_tool(settings, workspace)

    result = tool.invoke(
        {
            "script_name": "data_workspace",
            "args": ['{"action":"query","sql":"SELECT 1"}'],
        }
    )

    assert "DATA_WORKSPACE_QUERY_LIMIT_REACHED" in result
    assert not (tmp_path / "sandbox-runs").exists()


def test_data_workspace_markdown_preserves_aggregate_cents(tmp_path: Path) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    workspace = WorkspaceState(workspace_id="data-workspace-money", root_path=tmp_path)
    workspace.context["active_skill"] = "data/analyze"
    (tmp_path / "orders.csv").write_text(
        "order_id,revenue\nA,131700.25\nB,37.25\n",
        encoding="utf-8",
    )
    (tmp_path / "stale.json").write_text('{"wrong_total":999999}', encoding="utf-8")

    result = run_skill_python_script_locally(
        skills_root=repo_root / "skills",
        plugins_root=repo_root / "plugins",
        workspace_state=workspace,
        script_name="data_workspace",
        input_paths=["orders.csv"],
        args=[
            "--request-json",
            json.dumps(
                {
                    "action": "query",
                    "paths": ["orders.csv"],
                    "sql": "SELECT SUM(revenue) AS total_revenue FROM orders",
                }
            ),
        ],
    )

    markdown_path = next(
        tmp_path / output.path.lstrip("/")
        for output in result.output_files
        if output.path.endswith("/out/result.md")
    )
    assert "131737.5" in markdown_path.read_text(encoding="utf-8")
    json_path = next(
        tmp_path / output.path.lstrip("/")
        for output in result.output_files
        if output.path.endswith("/out/result.json")
    )
    payload = json.loads(json_path.read_text(encoding="utf-8"))
    assert payload["sourcePaths"] == ["orders.csv"]
    assert payload["tables"] == {"orders": "orders.csv"}


def test_data_workspace_accepts_query_compatibility_alias(tmp_path: Path) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    workspace = WorkspaceState(workspace_id="data-workspace-query-alias", root_path=tmp_path)
    workspace.context["active_skill"] = "data/analyze"
    (tmp_path / "orders.csv").write_text(
        "order_id,revenue\nA,10.25\nB,20.25\n",
        encoding="utf-8",
    )

    result = run_skill_python_script_locally(
        skills_root=repo_root / "skills",
        plugins_root=repo_root / "plugins",
        workspace_state=workspace,
        script_name="data_workspace",
        args=[
            json.dumps(
                {
                    "action": "query",
                    "paths": ["orders.csv"],
                    "query": "SELECT SUM(revenue) AS total_revenue FROM orders",
                }
            )
        ],
    )
    result_path = next(
        tmp_path / output.path.lstrip("/")
        for output in result.output_files
        if output.path.endswith("/out/result.json")
    )
    payload = json.loads(result_path.read_text(encoding="utf-8"))

    assert payload["rows"] == [{"total_revenue": 30.5}]


def test_report_payload_normalizes_legacy_sections_and_snapshot(tmp_path: Path) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    workspace = WorkspaceState(workspace_id="report-payload", root_path=tmp_path)
    workspace.context["active_skill"] = "data/analyze"
    request = {
        "manifest": {
            "title": "Growth Report",
            "sections": [
                {
                    "title": "Executive Summary",
                    "content": "Retention remained stable.",
                }
            ],
        },
        "snapshot": {"weekly": [{"week": "2026-07-20", "rate": 0.2}]},
        "sources": ["/weekly_growth.csv"],
    }

    result = run_skill_python_script_locally(
        skills_root=repo_root / "skills",
        plugins_root=repo_root / "plugins",
        workspace_state=workspace,
        script_name="build_report_payload",
        args=[json.dumps(request)],
    )
    result_path = next(
        tmp_path / output.path.lstrip("/")
        for output in result.output_files
        if output.path.endswith("/out/result.json")
    )
    payload = json.loads(result_path.read_text(encoding="utf-8"))

    assert payload["snapshot"] == {
        "datasets": {"weekly": [{"week": "2026-07-20", "rate": 0.2}]}
    }
    assert payload["manifest"]["blocks"][0]["body"].startswith(
        "# Growth Report\n\n## Executive Summary"
    )
    assert payload["ok"] is False
    assert "chart asset" in payload["errors"][0]
