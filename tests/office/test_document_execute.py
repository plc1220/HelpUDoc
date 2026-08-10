"""Contract tests for the direct model-facing OfficeCLI tool."""

from __future__ import annotations

import asyncio
import hashlib
import json

import pytest

from agent.helpudoc_agent.state import WorkspaceState
from agent.helpudoc_agent.tool_guard import GuardedTool
from agent.helpudoc_agent.tools.workspace.builtins import office as office_tool
from agent.helpudoc_agent.tools.workspace.office.config import OfficeRunnerConfig
from agent.helpudoc_agent.tools.workspace.office.models import ExecuteResponse
from agent.helpudoc_agent.tools.workspace.office.runner import execute_batch, reset_caches


def _config_for_fake(binary) -> OfficeRunnerConfig:
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    return OfficeRunnerConfig(
        officecli_bin=str(binary),
        expected_sha256_amd64=digest,
        expected_sha256_arm64=digest,
    )


def test_schema_does_not_expose_workspace_or_validation_controls(tmp_path, monkeypatch):
    workspace = WorkspaceState("ws", tmp_path / "ws")
    monkeypatch.setattr(office_tool, "is_binary_ready", lambda config: False)
    built = office_tool.build_document_execute_tool(workspace)
    properties = built.args_schema.model_json_schema()["properties"]

    assert set(properties) == {"source_path", "output_path", "operations", "create_if_missing"}
    assert "workspace_id" not in properties
    assert "validate" not in properties
    assert "best_effort" not in properties


@pytest.mark.asyncio
async def test_unavailable_binary_returns_stable_error(tmp_path, monkeypatch):
    workspace = WorkspaceState("ws", tmp_path / "ws")
    monkeypatch.setattr(office_tool, "is_binary_ready", lambda config: False)
    built = office_tool.build_document_execute_tool(workspace)

    result = json.loads(
        await built.ainvoke(
            {
                "output_path": "out.docx",
                "operations": [{"command": "view", "mode": "outline"}],
                "create_if_missing": True,
            }
        )
    )

    assert result["errorCode"] == "OFFICECLI_UNAVAILABLE"


@pytest.mark.asyncio
async def test_direct_runner_creates_validates_and_atomically_publishes(tmp_path, fake_officecli):
    reset_caches()
    workspace = WorkspaceState("ws", tmp_path / "workspaces" / "ws")
    output = workspace.root_path / "out.docx"
    config = _config_for_fake(fake_officecli)

    response = await execute_batch(
        config=config,
        semaphore=asyncio.Semaphore(1),
        workspace_base=workspace.root_path,
        source_resolved=None,
        output_resolved=output,
        operations=[{"command": "view", "mode": "outline"}],
        create_if_missing=True,
    )

    assert response.success is True
    assert response.published is True
    assert response.validation is not None and response.validation.success is True
    assert output.is_file()
    assert output.stat().st_mode & 0o777 == 0o644
    assert not list(output.parent.glob(".office-wip-*"))


@pytest.mark.asyncio
async def test_concurrent_writes_to_same_output_publish_complete_file(tmp_path, fake_officecli):
    reset_caches()
    workspace = WorkspaceState("ws", tmp_path / "workspaces" / "ws")
    output = workspace.root_path / "shared.docx"
    config = _config_for_fake(fake_officecli)
    semaphore = asyncio.Semaphore(1)

    async def run(command: str):
        return await execute_batch(
            config=config,
            semaphore=semaphore,
            workspace_base=workspace.root_path,
            source_resolved=None,
            output_resolved=output,
            operations=[{"command": command, "mode": "stats"}],
            create_if_missing=True,
        )

    first, second = await asyncio.gather(run("view"), run("view"))

    assert first.success and first.published
    assert second.success and second.published
    assert output.is_file()
    assert output.stat().st_mode & 0o777 == 0o644
    assert not list(output.parent.glob(".office-wip-*"))


@pytest.mark.asyncio
async def test_validation_failure_removes_unpublished_working_copy(
    tmp_path, fake_officecli, monkeypatch
):
    reset_caches()
    workspace = WorkspaceState("ws", tmp_path / "workspaces" / "ws")
    output = workspace.root_path / "invalid.docx"
    config = _config_for_fake(fake_officecli)
    from agent.helpudoc_agent.tools.workspace.office import runner

    def invalid_validate(*_args, **_kwargs):
        from agent.helpudoc_agent.tools.workspace.office.models import ValidationResult

        return ValidationResult(success=False, count=1, errors=["invalid"])

    monkeypatch.setattr(runner, "_parse_validate_output", invalid_validate)

    response = await execute_batch(
        config=config,
        semaphore=asyncio.Semaphore(1),
        workspace_base=workspace.root_path,
        source_resolved=None,
        output_resolved=output,
        operations=[{"command": "view", "mode": "stats"}],
        create_if_missing=True,
    )

    assert not response.success
    assert not response.published
    assert not output.exists()
    assert not list(output.parent.glob(".office-wip-*"))


@pytest.mark.asyncio
async def test_model_tool_rejects_validate_command_before_execution(tmp_path, monkeypatch):
    workspace = WorkspaceState("ws", tmp_path / "ws")
    monkeypatch.setattr(office_tool, "is_binary_ready", lambda config: True)
    built = office_tool.build_document_execute_tool(workspace)

    result = json.loads(
        await built.ainvoke(
            {
                "output_path": "out.docx",
                "operations": [{"command": "validate"}],
                "create_if_missing": True,
            }
        )
    )

    assert result["errorCode"] == "INVALID_DOCUMENT_REQUEST"


@pytest.mark.asyncio
async def test_model_tool_rejects_cross_format_and_traversal(tmp_path, monkeypatch):
    workspace = WorkspaceState("ws", tmp_path / "ws")
    monkeypatch.setattr(office_tool, "is_binary_ready", lambda config: True)
    built = office_tool.build_document_execute_tool(workspace)

    mismatch = json.loads(
        await built.ainvoke(
            {
                "source_path": "source.xlsx",
                "output_path": "out.docx",
                "operations": [{"command": "view", "mode": "outline"}],
            }
        )
    )
    traversal = json.loads(
        await built.ainvoke(
            {
                "output_path": "../out.docx",
                "operations": [{"command": "view", "mode": "outline"}],
                "create_if_missing": True,
            }
        )
    )

    assert mismatch["errorCode"] == "INVALID_DOCUMENT_REQUEST"
    assert traversal["errorCode"] == "PATH_OUTSIDE_WORKSPACE"


@pytest.mark.asyncio
async def test_model_tool_serializes_officecli_executions(tmp_path, monkeypatch):
    workspace = WorkspaceState("ws", tmp_path / "workspaces" / "ws")
    workspace.root_path.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(office_tool, "is_binary_ready", lambda config: True)
    active = 0
    peak = 0

    async def fake_execute_batch(**_kwargs):
        nonlocal active, peak
        semaphore = _kwargs["semaphore"]
        async with semaphore:
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.03)
            active -= 1
        return ExecuteResponse(
            success=True,
            published=True,
            officecli_version="1.0.143",
            duration_ms=30,
        )

    monkeypatch.setattr(office_tool, "execute_batch", fake_execute_batch)
    built = office_tool.build_document_execute_tool(workspace)
    payload = {
        "output_path": "out.docx",
        "operations": [{"command": "view", "mode": "stats"}],
        "create_if_missing": True,
    }

    await asyncio.gather(built.ainvoke(payload), built.ainvoke(payload))

    assert peak == 1


@pytest.mark.asyncio
async def test_model_tool_enforces_request_byte_limit(tmp_path, monkeypatch):
    monkeypatch.setenv("HELPUDOC_OFFICECLI_MAX_REQUEST_BYTES", "64")
    monkeypatch.setattr(office_tool, "is_binary_ready", lambda config: True)
    built = office_tool.build_document_execute_tool(WorkspaceState("ws", tmp_path / "ws"))

    result = json.loads(
        await built.ainvoke(
            {
                "output_path": "out.docx",
                "operations": [{"command": "view", "mode": "x" * 100}],
                "create_if_missing": True,
            }
        )
    )

    assert result["errorCode"] == "INVALID_DOCUMENT_REQUEST"
    assert "exceeds 64 bytes" in result["message"]


@pytest.mark.asyncio
async def test_workspace_write_policy_blocks_document_execute(tmp_path, monkeypatch):
    workspace = WorkspaceState("ws", tmp_path / "ws")
    workspace.context["can_write_workspace"] = False
    monkeypatch.setattr(office_tool, "is_binary_ready", lambda config: True)
    guarded = GuardedTool.from_tool(
        office_tool.build_document_execute_tool(workspace),
        workspace_state=workspace,
    )

    result = await guarded.ainvoke(
        {
            "output_path": "out.docx",
            "operations": [{"command": "view", "mode": "stats"}],
            "create_if_missing": True,
        }
    )

    assert "cannot write into this workspace" in result
