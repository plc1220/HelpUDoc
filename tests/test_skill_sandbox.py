from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from langchain_core.tools import tool

from agent.helpudoc_agent.sandbox_runner import (
    SandboxConfig,
    SandboxExecutionError,
    build_sandbox_job_manifest,
    run_skill_python_script_in_kubernetes,
    run_skill_python_script_locally,
)
from agent.helpudoc_agent.skills_registry import (
    SkillSandboxScript,
    activate_skill_context,
    load_skills,
)
from agent.helpudoc_agent.state import WorkspaceState
from agent.helpudoc_agent.tool_guard import GuardedTool


def _write_skill(
    tmp_path: Path,
    *,
    script_body: str = "print('ok')\n",
    script_path: str = "scripts/run.py",
) -> tuple[Path, str]:
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "demo"
    script_file = skill_dir / script_path
    script_file.parent.mkdir(parents=True, exist_ok=True)
    script_file.write_text(script_body, encoding="utf-8")
    digest = hashlib.sha256(script_file.read_bytes()).hexdigest()
    (skill_dir / "SKILL.md").write_text(
        f"""---
name: Demo
tools:
  - run_skill_python_script
sandbox_scripts:
  - name: run
    path: {script_path}
    sha256: "{digest}"
    timeout_seconds: 5
    outputs:
      - out/result.json
---

# Demo
""",
        encoding="utf-8",
    )
    return skills_root, digest


class FakeBatchApi:
    def __init__(self) -> None:
        self.created_body = None
        self.deleted = False

    def create_namespaced_job(self, *, namespace: str, body: dict) -> None:
        self.created_body = body

    def read_namespaced_job_status(self, *, name: str, namespace: str):
        return SimpleNamespace(status=SimpleNamespace(succeeded=1, failed=0))

    def delete_namespaced_job(self, *, name: str, namespace: str, propagation_policy: str) -> None:
        self.deleted = True


class FakeCoreApi:
    def list_namespaced_pod(self, *, namespace: str, label_selector: str):
        pod = SimpleNamespace(metadata=SimpleNamespace(name="sandbox-pod"))
        return SimpleNamespace(items=[pod])

    def read_namespaced_pod_log(self, *, name: str, namespace: str, container: str, tail_lines: int) -> str:
        return "hello from sandbox"


def test_load_skills_parses_sandbox_scripts(tmp_path: Path) -> None:
    skills_root, digest = _write_skill(tmp_path)

    skill = load_skills(skills_root)[0]

    assert skill.sandbox_scripts == [
        SkillSandboxScript(
            name="run",
            path="scripts/run.py",
            sha256=digest,
            timeout_seconds=5,
            outputs=["out/result.json"],
        )
    ]


def test_runner_rejects_undeclared_script(tmp_path: Path) -> None:
    skills_root, _digest = _write_skill(tmp_path)
    workspace = WorkspaceState(workspace_id="ws", root_path=tmp_path / "workspaces" / "ws")
    activate_skill_context(workspace.context, load_skills(skills_root)[0])

    with pytest.raises(SandboxExecutionError, match="not declared"):
        run_skill_python_script_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            script_name="missing",
            batch_api=FakeBatchApi(),
            core_api=FakeCoreApi(),
            sandbox_config=SandboxConfig(
                namespace="helpudoc",
                image="python:3.12-slim",
                workspace_pvc="workspace-pvc",
                runtime_class_name="gvisor",
                cpu_limit="500m",
                memory_limit="512Mi",
                ephemeral_storage_limit="1Gi",
                poll_interval_seconds=0.25,
            ),
        )


def test_runner_rejects_hash_mismatch(tmp_path: Path) -> None:
    skills_root, _digest = _write_skill(tmp_path)
    skill_file = skills_root / "demo" / "SKILL.md"
    skill_file.write_text(
        skill_file.read_text(encoding="utf-8").replace('sha256: "', 'sha256: "bad'),
        encoding="utf-8",
    )
    workspace = WorkspaceState(workspace_id="ws", root_path=tmp_path / "workspaces" / "ws")
    activate_skill_context(workspace.context, load_skills(skills_root)[0])

    with pytest.raises(SandboxExecutionError, match="hash mismatch"):
        run_skill_python_script_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            script_name="run",
            batch_api=FakeBatchApi(),
            core_api=FakeCoreApi(),
            sandbox_config=SandboxConfig.from_env(),
        )


def test_runner_rejects_script_path_traversal(tmp_path: Path) -> None:
    skills_root, _digest = _write_skill(tmp_path)
    skill_file = skills_root / "demo" / "SKILL.md"
    skill_file.write_text(
        skill_file.read_text(encoding="utf-8").replace("path: scripts/run.py", "path: ../run.py"),
        encoding="utf-8",
    )
    workspace = WorkspaceState(workspace_id="ws", root_path=tmp_path / "workspaces" / "ws")
    activate_skill_context(workspace.context, load_skills(skills_root)[0])

    with pytest.raises(SandboxExecutionError, match="relative to its source directory"):
        run_skill_python_script_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            script_name="run",
            batch_api=FakeBatchApi(),
            core_api=FakeCoreApi(),
            sandbox_config=SandboxConfig.from_env(),
        )


def test_runner_rejects_input_outside_workspace(tmp_path: Path) -> None:
    skills_root, _digest = _write_skill(tmp_path)
    outside = tmp_path / "secret.txt"
    outside.write_text("secret", encoding="utf-8")
    workspace = WorkspaceState(workspace_id="ws", root_path=tmp_path / "workspaces" / "ws")
    activate_skill_context(workspace.context, load_skills(skills_root)[0])

    with pytest.raises(SandboxExecutionError, match="outside the workspace"):
        run_skill_python_script_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            script_name="run",
            input_paths=[f"../{outside.name}"],
            batch_api=FakeBatchApi(),
            core_api=FakeCoreApi(),
            sandbox_config=SandboxConfig.from_env(),
        )


def test_runner_creates_hardened_job_and_deletes_it(tmp_path: Path) -> None:
    skills_root, _digest = _write_skill(tmp_path)
    workspace = WorkspaceState(workspace_id="ws", root_path=tmp_path / "workspaces" / "ws")
    (workspace.root_path / "source.txt").write_text("input", encoding="utf-8")
    activate_skill_context(workspace.context, load_skills(skills_root)[0])
    batch_api = FakeBatchApi()
    config = SandboxConfig(
        namespace="helpudoc",
        image="python:3.12-slim",
        workspace_pvc="workspace-pvc",
        runtime_class_name="gvisor",
        cpu_limit="500m",
        memory_limit="512Mi",
        ephemeral_storage_limit="1Gi",
        poll_interval_seconds=0.25,
    )

    result = run_skill_python_script_in_kubernetes(
        skills_root=skills_root,
        workspace_state=workspace,
        script_name="run",
        input_paths=["/source.txt"],
        args=["--input", "source.txt"],
        batch_api=batch_api,
        core_api=FakeCoreApi(),
        sandbox_config=config,
    )

    assert result.stdout == "hello from sandbox"
    assert batch_api.deleted is True
    body = batch_api.created_body
    pod_spec = body["spec"]["template"]["spec"]
    container = pod_spec["containers"][0]
    assert pod_spec["runtimeClassName"] == "gvisor"
    assert pod_spec["automountServiceAccountToken"] is False
    assert container["command"] == ["python", "/sandbox/scripts/run.py"]
    assert container["args"] == ["--input", "source.txt"]
    env = {item["name"]: item["value"] for item in container.get("env", [])}
    assert env["HOME"] == "/sandbox/tmp"
    assert env["PYTHONPATH"] == "/sandbox/scripts:/sandbox"
    assert container["securityContext"]["allowPrivilegeEscalation"] is False
    assert container["securityContext"]["readOnlyRootFilesystem"] is True
    assert container["securityContext"]["capabilities"]["drop"] == ["ALL"]
    assert container["volumeMounts"][0]["subPath"].startswith("ws/sandbox-runs/")
    assert "GEMINI_API_KEY" not in {item["name"] for item in container.get("env", [])}


def test_runner_stages_skill_scripts_tree_for_imports(tmp_path: Path) -> None:
    skills_root, _digest = _write_skill(
        tmp_path,
        script_body="import helper\nprint(helper.VALUE)\n",
        script_path="scripts/run.py",
    )
    helper = skills_root / "demo" / "scripts" / "helper.py"
    helper.write_text("VALUE = 'ok'\n", encoding="utf-8")
    workspace = WorkspaceState(workspace_id="ws", root_path=tmp_path / "workspaces" / "ws")
    activate_skill_context(workspace.context, load_skills(skills_root)[0])

    result = run_skill_python_script_in_kubernetes(
        skills_root=skills_root,
        workspace_state=workspace,
        script_name="run",
        batch_api=FakeBatchApi(),
        core_api=FakeCoreApi(),
        sandbox_config=SandboxConfig.from_env(),
    )

    run_dir = workspace.root_path / "sandbox-runs" / result.run_id
    assert (run_dir / "scripts" / "run.py").is_file()
    assert (run_dir / "scripts" / "helper.py").is_file()


def test_runner_deletes_job_when_wait_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    skills_root, _digest = _write_skill(tmp_path)
    workspace = WorkspaceState(workspace_id="ws", root_path=tmp_path / "workspaces" / "ws")
    activate_skill_context(workspace.context, load_skills(skills_root)[0])
    batch_api = FakeBatchApi()

    def fail_wait(*_args, **_kwargs):
        raise SandboxExecutionError("boom")

    monkeypatch.setattr("agent.helpudoc_agent.sandbox_runner._wait_for_job", fail_wait)

    with pytest.raises(SandboxExecutionError, match="boom"):
        run_skill_python_script_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            script_name="run",
            batch_api=batch_api,
            core_api=FakeCoreApi(),
            sandbox_config=SandboxConfig.from_env(),
        )

    assert batch_api.deleted is True


def test_build_manifest_uses_argv_not_shell() -> None:
    manifest = build_sandbox_job_manifest(
        job_name="job",
        workspace_id="ws",
        run_id="run",
        staged_script_name="run.py",
        args=["--name", "Ada"],
        script=SkillSandboxScript(name="run", path="scripts/run.py", sha256="abc", timeout_seconds=10),
        sandbox_config=SandboxConfig(
            namespace="helpudoc",
            image="python:3.12-slim",
            workspace_pvc="workspace-pvc",
            runtime_class_name="gvisor",
            cpu_limit="500m",
            memory_limit="512Mi",
            ephemeral_storage_limit="1Gi",
            poll_interval_seconds=0.25,
        ),
    )

    container = manifest["spec"]["template"]["spec"]["containers"][0]
    assert container["command"] == ["python", "/sandbox/scripts/run.py"]
    assert container["args"] == ["--name", "Ada"]


def test_build_manifest_rejects_unsafe_workspace_subpath() -> None:
    with pytest.raises(SandboxExecutionError, match="workspace_id"):
        build_sandbox_job_manifest(
            job_name="job",
            workspace_id="../ws",
            run_id="run",
            staged_script_name="run.py",
            args=[],
            script=SkillSandboxScript(name="run", path="scripts/run.py", sha256="abc", timeout_seconds=10),
            sandbox_config=SandboxConfig.from_env(),
        )


def test_guarded_tool_blocks_sandbox_tool_when_skill_omits_it(tmp_path: Path) -> None:
    @tool
    def run_skill_python_script(script_name: str) -> str:
        """Run a sandbox script."""
        return script_name

    workspace = WorkspaceState(workspace_id="ws", root_path=tmp_path / "ws")
    workspace.context["active_skill_scope"] = {
        "skill_id": "demo",
        "tools": ["google_search"],
        "mcp_servers": [],
    }

    guarded = GuardedTool.from_tool(run_skill_python_script, workspace_state=workspace)

    assert "not allowed" in guarded.invoke({"script_name": "run"}).lower()


def test_guarded_tool_blocks_sandbox_tool_for_legacy_empty_tool_allowlist(tmp_path: Path) -> None:
    @tool
    def run_skill_python_script(script_name: str) -> str:
        """Run a sandbox script."""
        return script_name

    workspace = WorkspaceState(workspace_id="ws", root_path=tmp_path / "ws")
    workspace.context["active_skill_scope"] = {
        "skill_id": "legacy",
        "tools": [],
        "mcp_servers": [],
    }

    guarded = GuardedTool.from_tool(run_skill_python_script, workspace_state=workspace)

    assert "not allowed" in guarded.invoke({"script_name": "run"}).lower()


def test_local_runner_builds_native_dashboard_package_from_plugin_script(tmp_path: Path) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    skills_root = repo_root / "skills"
    plugins_root = repo_root / "plugins"
    workspace = WorkspaceState(workspace_id="ws-local", root_path=tmp_path / "workspace")
    workspace.root_path.mkdir(parents=True, exist_ok=True)
    data_rows = [
        {"country": "US", "orders": 10, "revenue": 120.5},
        {"country": "MY", "orders": 7, "revenue": 91.0},
    ]
    request = {
        "title": "Orders Dashboard",
        "description": "Orders and revenue by country.",
        "output_path": "dashboards/orders",
        "rows": data_rows,
        "filter_schema": [{"field": "country", "label": "Country", "type": "categorical"}],
        "chart_bindings": [
            {
                "chart_id": "orders_by_country",
                "title": "Orders by Country",
                "chart_type": "bar",
                "x_field": "country",
                "y_field": "orders",
            }
        ],
    }
    skills = {skill.skill_id: skill for skill in load_skills(skills_root)}
    activate_skill_context(workspace.context, skills["data/dashboard"], plugins_root=plugins_root)

    result = run_skill_python_script_locally(
        skills_root=skills_root,
        plugins_root=plugins_root,
        workspace_state=workspace,
        script_name="build_native_dashboard_package",
        args=["--request-json", json.dumps(request)],
    )

    assert f"/sandbox-runs/{result.run_id}/out/dashboard_artifacts.json" in {
        output.path for output in result.output_files
    }
    dashboard_dir = workspace.root_path / "dashboards" / "orders"
    meta_path = dashboard_dir / "dashboard.meta.json"
    spec_path = dashboard_dir / "dashboard.spec.json"
    rows_path = dashboard_dir / "data" / "dashboard.rows.json"
    assert meta_path.is_file()
    assert spec_path.is_file()
    assert rows_path.is_file()
    assert not (dashboard_dir / "dashboard.snapshot.html").exists()

    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    assert spec["runtimeKind"] == "native"
    assert spec["version"] == 2
    assert spec["dataset"]["previewPath"] == "dashboards/orders/data/dashboard.rows.json"
    assert spec["filters"][0]["field"] == "country"
    assert spec["chartRuntimeDefs"][0]["chartId"] == "orders_by_country"
    assert spec["datasetSchema"]

    rows_payload = json.loads(rows_path.read_text(encoding="utf-8"))
    assert rows_payload == {"rows": data_rows}


def test_run_skill_python_script_tool_emits_script_artifact_events(tmp_path: Path) -> None:
    from agent.helpudoc_agent.tools.workspace.builtins.skills import build_run_skill_python_script_tool

    repo_root = Path(__file__).resolve().parents[1]
    skills_root = repo_root / "skills"
    plugins_root = repo_root / "plugins"
    workspace = WorkspaceState(workspace_id="ws-local", root_path=tmp_path / "workspace")
    workspace.root_path.mkdir(parents=True, exist_ok=True)
    skills = {skill.skill_id: skill for skill in load_skills(skills_root)}
    activate_skill_context(workspace.context, skills["data/dashboard"], plugins_root=plugins_root)
    settings = SimpleNamespace(backend=SimpleNamespace(skills_root=skills_root, plugins_root=plugins_root))
    tool_obj = build_run_skill_python_script_tool(settings, workspace)
    events: list[tuple[str, dict]] = []

    class FakeCallbacks:
        run_id = "callback-run"

        def on_custom_event(self, name: str, payload: dict, **_kwargs) -> None:
            events.append((name, payload))

    request = {
        "title": "Events Dashboard",
        "output_path": "dashboards/events",
        "rows": [{"segment": "A", "value": 1}],
        "filter_schema": [{"field": "segment"}],
        "chart_bindings": [{"title": "Value", "x_field": "segment", "y_field": "value"}],
    }

    response = tool_obj.func(
        script_name="build_native_dashboard_package",
        args=["--request-json", json.dumps(request)],
        callbacks=FakeCallbacks(),
    )

    assert "SKILL_SANDBOX_RUN_COMPLETED" in response
    event_names = [name for name, _payload in events]
    assert "tool_artifacts" in event_names
    assert "dashboard_artifact" in event_names
    dashboard_event = next(payload for name, payload in events if name == "dashboard_artifact")
    assert dashboard_event["workspaceId"] == "ws-local"
    assert dashboard_event["dashboardPath"] == "dashboards/events"
