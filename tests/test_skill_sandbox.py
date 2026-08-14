from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from langchain_core.tools import tool

from agent.helpudoc_agent import sandbox_runner

from agent.helpudoc_agent.sandbox_runner import (
    INLINE_ENTRYPOINT_NAME,
    INLINE_MAX_EXECUTIONS_PER_AGENT_RUN,
    INLINE_MAX_SOURCE_BYTES,
    INLINE_RUN_MARKER_NAME,
    InlineSandboxDisabledError,
    InlineWorkspaceUnavailableError,
    SandboxConfig,
    SandboxExecutionError,
    SandboxUnavailableError,
    build_inline_sandbox_job_manifest,
    build_sandbox_job_manifest,
    cleanup_stale_inline_run_dirs,
    cleanup_stale_inline_run_dirs_under_root,
    reset_inline_job_accounting_for_tests,
    run_inline_python_in_kubernetes,
    run_skill_python_script,
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


@pytest.fixture(autouse=True)
def _reset_inline_job_accounting():
    reset_inline_job_accounting_for_tests()
    yield
    reset_inline_job_accounting_for_tests()


def _sandbox_config() -> SandboxConfig:
    return SandboxConfig(
        namespace="helpudoc",
        image="helpudoc/agent:pinned",
        workspace_pvc="workspace-pvc",
        runtime_class_name="gvisor",
        cpu_limit="500m",
        memory_limit="512Mi",
        ephemeral_storage_limit="1Gi",
        poll_interval_seconds=0.01,
    )


def _inline_workspace(tmp_path: Path, name: str = "ws") -> tuple[Path, WorkspaceState]:
    skills_root, _digest = _write_skill(tmp_path)
    workspace = WorkspaceState(workspace_id=name, root_path=tmp_path / "workspaces" / name)
    activate_skill_context(workspace.context, load_skills(skills_root)[0])
    return skills_root, workspace


def _enable_inline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SANDBOX_INLINE_ENABLED", "true")


class FakeInlineBatchApi(FakeBatchApi):
    """Fake Job API that materializes sandbox output files at create time."""

    def __init__(self, workspace: WorkspaceState, *, writes=None, on_create=None) -> None:
        super().__init__()
        self.workspace = workspace
        self.writes = dict(writes or {})
        self.on_create = on_create
        self.run_dir: Path | None = None

    def create_namespaced_job(self, *, namespace: str, body: dict) -> None:
        super().create_namespaced_job(namespace=namespace, body=body)
        run_id = body["metadata"]["labels"]["helpudoc.io/sandbox-run-id"]
        self.run_dir = self.workspace.root_path / "sandbox-runs" / run_id
        for rel, content in self.writes.items():
            target = self.run_dir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        if self.on_create is not None:
            self.on_create(self.run_dir)


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
        input_paths=["source.txt"],
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
    affinity_term = pod_spec["affinity"]["podAffinity"][
        "requiredDuringSchedulingIgnoredDuringExecution"
    ][0]
    assert affinity_term["labelSelector"]["matchLabels"] == {"app": "helpudoc-app"}
    assert affinity_term["topologyKey"] == "kubernetes.io/hostname"
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


def test_declared_manifest_omits_unconfigured_runtime_class() -> None:
    config = SandboxConfig.from_env()
    manifest = build_sandbox_job_manifest(
        job_name="job",
        workspace_id="ws",
        run_id="run",
        staged_script_name="scripts/run.py",
        args=[],
        script=SkillSandboxScript(
            name="run",
            path="scripts/run.py",
            sha256="0" * 64,
            timeout_seconds=120,
            outputs=[],
        ),
        sandbox_config=config,
    )

    assert config.runtime_class_name == ""
    assert "runtimeClassName" not in manifest["spec"]["template"]["spec"]


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


def test_guarded_tool_denies_sandbox_when_skill_omits_it(tmp_path: Path) -> None:
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

    assert "is not allowed" in guarded.invoke({"script_name": "run"})


def test_guarded_tool_denies_sandbox_for_legacy_empty_allowlist(tmp_path: Path) -> None:
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

    assert "is not allowed" in guarded.invoke({"script_name": "run"})


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


def test_native_dashboard_builder_preserves_explicit_csv_sentinels_and_anomalies(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    skills_root = repo_root / "skills"
    plugins_root = repo_root / "plugins"
    workspace = WorkspaceState(workspace_id="ws-fidelity", root_path=tmp_path / "workspace")
    workspace.root_path.mkdir(parents=True, exist_ok=True)
    source = repo_root / "tests" / "fixtures" / "data-analytics-qc" / "orders_dirty.csv"
    dataset = workspace.root_path / "orders_dirty.csv"
    dataset.write_bytes(source.read_bytes())
    request = {
        "title": "Dirty Source Fidelity",
        "description": "Preserve source anomalies for explicit review.",
        "output_path": "dashboards/dirty-source-fidelity",
        "dashboard_dataset_path": "orders_dirty.csv",
        "filter_schema": [
            {"field": "order_date", "label": "Order date", "type": "date"},
            {"field": "country", "label": "Country", "type": "categorical"},
        ],
        "chart_bindings": [
            {
                "chart_id": "revenue_by_date",
                "title": "Revenue by order date",
                "chart_type": "line",
                "x_field": "order_date",
                "y_field": "revenue",
            }
        ],
        "data_quality_notes": ["No source values were transformed or excluded."],
    }
    skills = {skill.skill_id: skill for skill in load_skills(skills_root)}
    activate_skill_context(workspace.context, skills["data/dashboard"], plugins_root=plugins_root)

    run_skill_python_script_locally(
        skills_root=skills_root,
        plugins_root=plugins_root,
        workspace_state=workspace,
        script_name="build_native_dashboard_package",
        args=["--request-json", json.dumps(request)],
    )

    rows_path = (
        workspace.root_path
        / "dashboards"
        / "dirty-source-fidelity"
        / "data"
        / "dashboard.rows.json"
    )
    rows = json.loads(rows_path.read_text(encoding="utf-8"))["rows"]

    assert len(rows) == 25
    assert next(row for row in rows if row["order_id"] == "ORD-009")["country"] == "N/A"
    assert next(row for row in rows if row["order_id"] == "ORD-011")["revenue"] == 99999.0
    assert next(row for row in rows if row["order_id"] == "ORD-012")["revenue"] is None
    assert next(row for row in rows if row["order_id"] == "ORD-024")["order_date"] == "2030-01-01"


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


# --- Gate B: inline sandbox execution ---------------------------------------


def test_inline_mode_disabled_by_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SANDBOX_INLINE_ENABLED", raising=False)
    skills_root, workspace = _inline_workspace(tmp_path)

    with pytest.raises(InlineSandboxDisabledError, match="SANDBOX_INLINE_DISABLED"):
        run_skill_python_script(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            output_paths=["outputs/final.txt"],
        )


def test_inline_mode_is_kubernetes_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_inline(monkeypatch)
    monkeypatch.setenv("HELPUDOC_SANDBOX_BACKEND", "local")
    skills_root, workspace = _inline_workspace(tmp_path)

    with pytest.raises(SandboxUnavailableError, match="SANDBOX_UNAVAILABLE"):
        run_skill_python_script(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            output_paths=["outputs/final.txt"],
        )


def test_script_name_and_inline_code_are_mutually_exclusive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)

    with pytest.raises(SandboxExecutionError, match="exactly one of script_name or inline_code"):
        run_skill_python_script(
            skills_root=skills_root,
            workspace_state=workspace,
            script_name="run",
            inline_code="print('hi')\n",
            output_paths=["outputs/final.txt"],
        )

    with pytest.raises(SandboxExecutionError, match="exactly one of script_name or inline_code"):
        run_skill_python_script(skills_root=skills_root, workspace_state=workspace)


def test_inline_requires_an_active_skill(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_inline(monkeypatch)
    skills_root, _digest = _write_skill(tmp_path)
    workspace = WorkspaceState(workspace_id="ws", root_path=tmp_path / "workspaces" / "ws")

    with pytest.raises(SandboxExecutionError, match="Load a skill"):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            output_paths=["outputs/final.txt"],
            batch_api=FakeBatchApi(),
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
        )


def test_inline_requires_explicit_output_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)

    with pytest.raises(SandboxExecutionError, match="INLINE_OUTPUTS_REQUIRED"):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            batch_api=FakeBatchApi(),
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
        )


@pytest.mark.parametrize(
    ("field", "kwargs"),
    [
        ("input_paths", {"input_paths": ["/workspace/source.txt"], "output_paths": ["out.txt"]}),
        ("output_paths", {"output_paths": ["/workspace/outputs/final.txt"]}),
    ],
)
def test_inline_rejects_absolute_workspace_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str, kwargs: dict
) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)
    batch_api = FakeBatchApi()

    with pytest.raises(InlineWorkspaceUnavailableError, match="INLINE_WORKSPACE_UNAVAILABLE"):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            batch_api=batch_api,
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
            **kwargs,
        )

    assert field in {"input_paths", "output_paths"}
    assert batch_api.created_body is None


def test_inline_manifest_omits_workspace_mount_and_root_env() -> None:
    manifest = build_inline_sandbox_job_manifest(
        job_name="job",
        workspace_id="ws",
        run_id="inline-abc",
        timeout_seconds=120,
        sandbox_config=_sandbox_config(),
    )

    pod_spec = manifest["spec"]["template"]["spec"]
    container = pod_spec["containers"][0]
    mount_paths = {mount["mountPath"] for mount in container["volumeMounts"]}
    env_names = {item["name"] for item in container["env"]}

    assert mount_paths == {"/sandbox"}
    assert "/workspace" not in mount_paths
    assert "HELPUDOC_WORKSPACE_ROOT" not in env_names
    assert "HELPUDOC_WORKSPACE_OUTPUT_ROOT" not in env_names
    assert not {"GEMINI_API_KEY", "GOOGLE_API_KEY", "KUBERNETES_SERVICE_HOST"} & env_names
    # deny-egress NetworkPolicy selector and hardening must be preserved.
    assert manifest["metadata"]["labels"]["app"] == "helpudoc-skill-sandbox"
    assert manifest["spec"]["template"]["metadata"]["labels"]["app"] == "helpudoc-skill-sandbox"
    assert pod_spec["automountServiceAccountToken"] is False
    affinity_term = pod_spec["affinity"]["podAffinity"][
        "requiredDuringSchedulingIgnoredDuringExecution"
    ][0]
    assert affinity_term["labelSelector"]["matchLabels"] == {"app": "helpudoc-app"}
    assert affinity_term["topologyKey"] == "kubernetes.io/hostname"
    assert pod_spec["runtimeClassName"] == "gvisor"
    assert pod_spec["securityContext"]["runAsNonRoot"] is True
    assert pod_spec["securityContext"]["seccompProfile"] == {"type": "RuntimeDefault"}
    assert container["securityContext"]["allowPrivilegeEscalation"] is False
    assert container["securityContext"]["readOnlyRootFilesystem"] is True
    assert container["securityContext"]["capabilities"]["drop"] == ["ALL"]
    assert manifest["spec"]["backoffLimit"] == 0
    assert manifest["spec"]["activeDeadlineSeconds"] == 150
    assert manifest["spec"]["ttlSecondsAfterFinished"] == 300
    # Fixed entrypoint, no shell, no model-supplied argv.
    assert container["command"] == ["python", f"/sandbox/scripts/{INLINE_ENTRYPOINT_NAME}"]
    assert container["args"] == []


def test_inline_run_stages_named_inputs_and_publishes_declared_outputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)
    (workspace.root_path / "inputs").mkdir(parents=True, exist_ok=True)
    (workspace.root_path / "inputs" / "source.txt").write_text("payload", encoding="utf-8")
    (workspace.root_path / "unrelated.txt").write_text("do not stage", encoding="utf-8")
    staged: dict[str, list[str]] = {}

    def capture(run_dir: Path) -> None:
        staged["names"] = sorted(item.name for item in run_dir.iterdir())

    batch_api = FakeInlineBatchApi(
        workspace,
        writes={"outputs/final.txt": "generated"},
        on_create=capture,
    )

    result = run_inline_python_in_kubernetes(
        skills_root=skills_root,
        workspace_state=workspace,
        inline_code="from pathlib import Path\nPath('outputs/final.txt').write_text('generated')\n",
        input_paths=["inputs/source.txt"],
        output_paths=["outputs/final.txt"],
        batch_api=batch_api,
        core_api=FakeCoreApi(),
        sandbox_config=_sandbox_config(),
    )

    assert result.mode == "inline"
    assert len(result.source_sha256) == 64
    assert [item.path for item in result.output_files] == ["/outputs/final.txt"]
    published = workspace.root_path / "outputs" / "final.txt"
    assert published.read_text(encoding="utf-8") == "generated"
    # Only named inputs are staged, by basename, read-only.
    assert "source.txt" in staged["names"]
    assert "unrelated.txt" not in staged["names"]
    assert batch_api.run_dir is not None
    # Run directory is deleted after publication, and nothing lingers.
    assert not batch_api.run_dir.exists()
    assert not any((workspace.root_path / "sandbox-runs").iterdir())


def test_inline_staged_inputs_are_read_only_and_entrypoint_is_fixed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)
    (workspace.root_path / "source.txt").write_text("payload", encoding="utf-8")
    observed: dict[str, object] = {}

    def capture(run_dir: Path) -> None:
        entrypoint = run_dir / "scripts" / INLINE_ENTRYPOINT_NAME
        observed["entrypoint_exists"] = entrypoint.is_file()
        observed["entrypoint_source"] = entrypoint.read_text(encoding="utf-8")
        observed["input_mode"] = (run_dir / "source.txt").stat().st_mode & 0o222
        observed["marker"] = (run_dir / INLINE_RUN_MARKER_NAME).is_file()
        (run_dir / "out.txt").write_text("done", encoding="utf-8")

    run_inline_python_in_kubernetes(
        skills_root=skills_root,
        workspace_state=workspace,
        inline_code="print('fixed entrypoint')\n",
        input_paths=["source.txt"],
        output_paths=["out.txt"],
        batch_api=FakeInlineBatchApi(workspace, on_create=capture),
        core_api=FakeCoreApi(),
        sandbox_config=_sandbox_config(),
    )

    assert observed["entrypoint_exists"] is True
    assert observed["entrypoint_source"] == "print('fixed entrypoint')\n"
    assert observed["input_mode"] == 0
    assert observed["marker"] is True


def test_inline_does_not_publish_undeclared_outputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)
    batch_api = FakeInlineBatchApi(
        workspace,
        writes={"outputs/final.txt": "declared", "outputs/extra.txt": "undeclared"},
    )

    result = run_inline_python_in_kubernetes(
        skills_root=skills_root,
        workspace_state=workspace,
        inline_code="print('hi')\n",
        output_paths=["outputs/final.txt"],
        batch_api=batch_api,
        core_api=FakeCoreApi(),
        sandbox_config=_sandbox_config(),
    )

    assert [item.path for item in result.output_files] == ["/outputs/final.txt"]
    assert (workspace.root_path / "outputs" / "final.txt").is_file()
    assert not (workspace.root_path / "outputs" / "extra.txt").exists()


def test_inline_rejects_output_path_traversal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)

    with pytest.raises(SandboxExecutionError, match="must be relative"):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            output_paths=["../escape.txt"],
            batch_api=FakeBatchApi(),
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
        )


@pytest.mark.parametrize(
    ("input_paths", "output_paths"),
    [(["/etc/passwd"], ["out.txt"]), ([], ["/tmp/out.txt"]), ([], ["."])],
)
def test_inline_rejects_absolute_and_control_output_paths(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    input_paths: list[str],
    output_paths: list[str],
) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)
    batch_api = FakeBatchApi()

    with pytest.raises(SandboxExecutionError, match="relative|outside"):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            input_paths=input_paths,
            output_paths=output_paths,
            batch_api=batch_api,
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
        )

    assert batch_api.created_body is None


def test_inline_in_place_edit_uses_a_writable_copy_and_atomic_publish(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)
    source = workspace.root_path / "source.txt"
    source.write_text("original", encoding="utf-8")
    observed: dict[str, int] = {}

    def edit_staged_copy(run_dir: Path) -> None:
        staged = run_dir / "source.txt"
        observed["write_bits"] = staged.stat().st_mode & 0o222
        staged.write_text("updated", encoding="utf-8")

    result = run_inline_python_in_kubernetes(
        skills_root=skills_root,
        workspace_state=workspace,
        inline_code="from pathlib import Path\nPath('source.txt').write_text('updated')\n",
        input_paths=["source.txt"],
        output_paths=["source.txt"],
        batch_api=FakeInlineBatchApi(workspace, on_create=edit_staged_copy),
        core_api=FakeCoreApi(),
        sandbox_config=_sandbox_config(),
    )

    assert observed["write_bits"] != 0
    assert source.read_text(encoding="utf-8") == "updated"
    assert [item.path for item in result.output_files] == ["/source.txt"]


def test_inline_rejects_symlinked_output(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)
    secret = tmp_path / "secret.txt"
    secret.write_text("secret", encoding="utf-8")

    def plant_symlink(run_dir: Path) -> None:
        target = run_dir / "outputs" / "final.txt"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(secret)

    with pytest.raises(SandboxExecutionError, match="symlink"):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            output_paths=["outputs/final.txt"],
            batch_api=FakeInlineBatchApi(workspace, on_create=plant_symlink),
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
        )

    assert not (workspace.root_path / "outputs" / "final.txt").exists()


def test_inline_rejects_special_file_output(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)

    def plant_fifo(run_dir: Path) -> None:
        outputs = run_dir / "outputs"
        outputs.mkdir(parents=True, exist_ok=True)
        os.mkfifo(outputs / "pipe")

    with pytest.raises(SandboxExecutionError, match="special file"):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            output_paths=["outputs"],
            batch_api=FakeInlineBatchApi(workspace, on_create=plant_fifo),
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
        )

    assert not (workspace.root_path / "outputs").exists()


def test_inline_rejects_too_many_output_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_inline(monkeypatch)
    monkeypatch.setattr(sandbox_runner, "INLINE_MAX_OUTPUT_FILES", 2)
    skills_root, workspace = _inline_workspace(tmp_path)

    def plant_many(run_dir: Path) -> None:
        outputs = run_dir / "outputs"
        outputs.mkdir(parents=True, exist_ok=True)
        for index in range(3):
            (outputs / f"file{index}.txt").write_text("x", encoding="utf-8")

    with pytest.raises(SandboxExecutionError, match="INLINE_OUTPUT_LIMIT_EXCEEDED"):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            output_paths=["outputs"],
            batch_api=FakeInlineBatchApi(workspace, on_create=plant_many),
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
        )

    assert not (workspace.root_path / "outputs").exists()


def test_inline_rejects_oversized_output(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_inline(monkeypatch)
    monkeypatch.setattr(sandbox_runner, "INLINE_MAX_OUTPUT_BYTES", 8)
    skills_root, workspace = _inline_workspace(tmp_path)

    with pytest.raises(SandboxExecutionError, match="INLINE_OUTPUT_TOO_LARGE"):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            output_paths=["outputs/final.txt"],
            batch_api=FakeInlineBatchApi(workspace, writes={"outputs/final.txt": "x" * 64}),
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
        )

    assert not (workspace.root_path / "outputs" / "final.txt").exists()


def test_inline_rejects_oversized_total_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_inline(monkeypatch)
    monkeypatch.setattr(sandbox_runner, "INLINE_MAX_TOTAL_OUTPUT_BYTES", 16)
    skills_root, workspace = _inline_workspace(tmp_path)

    with pytest.raises(SandboxExecutionError, match="INLINE_TOTAL_OUTPUT_TOO_LARGE"):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            output_paths=["a.txt", "b.txt"],
            batch_api=FakeInlineBatchApi(
                workspace, writes={"a.txt": "x" * 12, "b.txt": "y" * 12}
            ),
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
        )

    assert not (workspace.root_path / "a.txt").exists()
    assert not (workspace.root_path / "b.txt").exists()


def test_inline_rejects_oversized_source(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)

    with pytest.raises(SandboxExecutionError, match="INLINE_SOURCE_TOO_LARGE"):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="#" * (INLINE_MAX_SOURCE_BYTES + 1),
            output_paths=["out.txt"],
            batch_api=FakeBatchApi(),
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
        )


def test_inline_rejects_timeout_above_maximum(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)

    with pytest.raises(SandboxExecutionError, match="INLINE_TIMEOUT_TOO_LARGE"):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            output_paths=["out.txt"],
            timeout_seconds=301,
            batch_api=FakeBatchApi(),
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
        )


def test_inline_rejects_too_many_inputs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)

    with pytest.raises(SandboxExecutionError, match="INLINE_INPUT_LIMIT_EXCEEDED"):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            input_paths=[f"file{index}.txt" for index in range(17)],
            output_paths=["out.txt"],
            batch_api=FakeBatchApi(),
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
        )


def test_inline_enforces_executions_per_agent_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)

    for _ in range(INLINE_MAX_EXECUTIONS_PER_AGENT_RUN):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            output_paths=["out.txt"],
            batch_api=FakeInlineBatchApi(workspace, writes={"out.txt": "ok"}),
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
        )

    with pytest.raises(SandboxExecutionError, match="INLINE_EXECUTION_LIMIT_REACHED"):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            output_paths=["out.txt"],
            batch_api=FakeInlineBatchApi(workspace, writes={"out.txt": "ok"}),
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
        )


def test_inline_allows_only_one_active_job_per_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)
    nested: dict[str, Exception] = {}

    def start_nested_run(run_dir: Path) -> None:
        (run_dir / "out.txt").write_text("ok", encoding="utf-8")
        try:
            run_inline_python_in_kubernetes(
                skills_root=skills_root,
                workspace_state=workspace,
                inline_code="print('nested')\n",
                output_paths=["nested.txt"],
                batch_api=FakeInlineBatchApi(workspace, writes={"nested.txt": "nested"}),
                core_api=FakeCoreApi(),
                sandbox_config=_sandbox_config(),
            )
        except SandboxExecutionError as exc:
            nested["error"] = exc

    run_inline_python_in_kubernetes(
        skills_root=skills_root,
        workspace_state=workspace,
        inline_code="print('outer')\n",
        output_paths=["out.txt"],
        batch_api=FakeInlineBatchApi(workspace, on_create=start_nested_run),
        core_api=FakeCoreApi(),
        sandbox_config=_sandbox_config(),
    )

    assert "INLINE_WORKSPACE_JOB_LIMIT_REACHED" in str(nested["error"])
    assert not (workspace.root_path / "nested.txt").exists()


def test_inline_enforces_configurable_global_job_ceiling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_inline(monkeypatch)
    monkeypatch.setenv("SANDBOX_INLINE_MAX_GLOBAL_JOBS", "1")
    skills_root, workspace_a = _inline_workspace(tmp_path, "ws-a")
    workspace_b = WorkspaceState(workspace_id="ws-b", root_path=tmp_path / "workspaces" / "ws-b")
    activate_skill_context(workspace_b.context, load_skills(skills_root)[0])
    nested: dict[str, Exception] = {}

    def start_other_workspace_run(run_dir: Path) -> None:
        (run_dir / "out.txt").write_text("ok", encoding="utf-8")
        try:
            run_inline_python_in_kubernetes(
                skills_root=skills_root,
                workspace_state=workspace_b,
                inline_code="print('other')\n",
                output_paths=["out.txt"],
                batch_api=FakeInlineBatchApi(workspace_b, writes={"out.txt": "ok"}),
                core_api=FakeCoreApi(),
                sandbox_config=_sandbox_config(),
            )
        except SandboxExecutionError as exc:
            nested["error"] = exc

    run_inline_python_in_kubernetes(
        skills_root=skills_root,
        workspace_state=workspace_a,
        inline_code="print('outer')\n",
        output_paths=["out.txt"],
        batch_api=FakeInlineBatchApi(workspace_a, on_create=start_other_workspace_run),
        core_api=FakeCoreApi(),
        sandbox_config=_sandbox_config(),
    )

    assert "INLINE_GLOBAL_JOB_LIMIT_REACHED" in str(nested["error"])


def test_inline_run_dir_is_cleaned_when_the_job_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)
    batch_api = FakeInlineBatchApi(workspace, writes={"out.txt": "partial"})

    def fail_wait(*_args, **_kwargs):
        raise SandboxExecutionError("boom")

    monkeypatch.setattr(sandbox_runner, "_wait_for_job", fail_wait)

    with pytest.raises(SandboxExecutionError, match="boom"):
        run_inline_python_in_kubernetes(
            skills_root=skills_root,
            workspace_state=workspace,
            inline_code="print('hi')\n",
            output_paths=["out.txt"],
            batch_api=batch_api,
            core_api=FakeCoreApi(),
            sandbox_config=_sandbox_config(),
        )

    assert batch_api.deleted is True
    assert batch_api.run_dir is not None and not batch_api.run_dir.exists()
    assert not (workspace.root_path / "out.txt").exists()


def test_stale_inline_run_dirs_are_cleaned_opportunistically(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)
    runs_root = workspace.root_path / "sandbox-runs"
    stale = runs_root / "inline-stale"
    stale.mkdir(parents=True, exist_ok=True)
    (stale / INLINE_RUN_MARKER_NAME).write_text("hash\n", encoding="utf-8")
    old = time.time() - 7200
    os.utime(stale, (old, old))
    fresh = runs_root / "inline-fresh"
    fresh.mkdir(parents=True, exist_ok=True)
    (fresh / INLINE_RUN_MARKER_NAME).write_text("hash\n", encoding="utf-8")
    declared = runs_root / "deadbeef"
    declared.mkdir(parents=True, exist_ok=True)
    os.utime(declared, (old, old))

    removed = cleanup_stale_inline_run_dirs(workspace)

    assert removed == ["inline-stale"]
    assert not stale.exists()
    assert fresh.exists()
    assert declared.exists()


def test_startup_sweep_removes_stale_inline_run_dirs_across_workspaces(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspaces"
    old = time.time() - 7200
    stale_dirs = []
    for name in ("ws-a", "ws-b"):
        stale = workspace_root / name / "sandbox-runs" / f"inline-{name}"
        stale.mkdir(parents=True, exist_ok=True)
        (stale / INLINE_RUN_MARKER_NAME).write_text("hash\n", encoding="utf-8")
        os.utime(stale, (old, old))
        stale_dirs.append(stale)
    declared = workspace_root / "ws-a" / "sandbox-runs" / "declared-run"
    declared.mkdir(parents=True, exist_ok=True)
    os.utime(declared, (old, old))

    removed = cleanup_stale_inline_run_dirs_under_root(workspace_root)

    assert removed == ["ws-a/inline-ws-a", "ws-b/inline-ws-b"]
    assert all(not path.exists() for path in stale_dirs)
    assert declared.exists()


def test_declared_script_behaviour_is_unchanged_when_inline_is_enabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_inline(monkeypatch)
    monkeypatch.setenv("HELPUDOC_SANDBOX_BACKEND", "kubernetes")
    skills_root, workspace = _inline_workspace(tmp_path)
    (workspace.root_path / "source.txt").write_text("input", encoding="utf-8")
    batch_api = FakeBatchApi()
    monkeypatch.setattr(
        sandbox_runner,
        "_load_kubernetes_clients",
        lambda: (batch_api, FakeCoreApi()),
    )

    result = run_skill_python_script(
        skills_root=skills_root,
        workspace_state=workspace,
        script_name="run",
        input_paths=["/source.txt"],
        args=["--input", "source.txt"],
    )

    container = batch_api.created_body["spec"]["template"]["spec"]["containers"][0]
    env = {item["name"]: item["value"] for item in container["env"]}
    mount_paths = {mount["mountPath"] for mount in container["volumeMounts"]}

    assert result.mode == "declared"
    assert result.source_sha256 is None
    assert result.stdout == "hello from sandbox"
    assert container["command"] == ["python", "/sandbox/scripts/run.py"]
    assert container["args"] == ["--input", "source.txt"]
    # Reviewed declared scripts keep their read-only workspace mount.
    assert "/workspace" in mount_paths
    assert env["HELPUDOC_WORKSPACE_ROOT"] == "/workspace"
    # The declared run directory is retained for its declared-output references.
    assert (workspace.root_path / "sandbox-runs" / result.run_id).is_dir()


def test_declared_mode_rejects_inline_only_arguments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)

    with pytest.raises(SandboxExecutionError, match="output_paths is only supported"):
        run_skill_python_script(
            skills_root=skills_root,
            workspace_state=workspace,
            script_name="run",
            output_paths=["out.txt"],
        )

    with pytest.raises(SandboxExecutionError, match="timeout_seconds is only supported"):
        run_skill_python_script(
            skills_root=skills_root,
            workspace_state=workspace,
            script_name="run",
            timeout_seconds=30,
        )


def test_inline_tool_reports_disabled_flag_without_running(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agent.helpudoc_agent.tools.workspace.builtins.skills import (
        build_run_skill_python_script_tool,
    )

    monkeypatch.delenv("SANDBOX_INLINE_ENABLED", raising=False)
    skills_root, workspace = _inline_workspace(tmp_path)
    settings = SimpleNamespace(backend=SimpleNamespace(skills_root=skills_root, plugins_root=None))
    tool_obj = build_run_skill_python_script_tool(settings, workspace)

    response = tool_obj.func(
        inline_code="print('hi')\n",
        output_paths=["outputs/final.txt"],
    )

    assert "SANDBOX_INLINE_DISABLED" in response


def test_inline_tool_rejects_both_and_neither_modes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agent.helpudoc_agent.tools.workspace.builtins.skills import (
        build_run_skill_python_script_tool,
    )

    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)
    settings = SimpleNamespace(backend=SimpleNamespace(skills_root=skills_root, plugins_root=None))
    tool_obj = build_run_skill_python_script_tool(settings, workspace)

    both = tool_obj.func(script_name="run", inline_code="print('hi')\n")
    neither = tool_obj.func()

    from helpudoc_agent.api.routes.chat import _is_terminal_tool_failure

    for response in (both, neither):
        payload = json.loads(response)
        assert payload["status"] == "error"
        assert payload["errorCode"] == "SKILL_SANDBOX_REQUEST_INVALID"
        assert payload["retryable"] is False
        assert payload["suggestedNextCall"]
        assert _is_terminal_tool_failure("run_skill_python_script", response) is True


def test_tool_rejects_arguments_from_the_other_execution_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agent.helpudoc_agent.tools.workspace.builtins.skills import (
        build_run_skill_python_script_tool,
    )

    _enable_inline(monkeypatch)
    skills_root, workspace = _inline_workspace(tmp_path)
    settings = SimpleNamespace(backend=SimpleNamespace(skills_root=skills_root, plugins_root=None))
    tool_obj = build_run_skill_python_script_tool(settings, workspace)

    inline_with_args = tool_obj.func(
        inline_code="print('hi')\n",
        output_paths=["out.txt"],
        args=["ignored-before-fix"],
    )
    declared_with_outputs = tool_obj.func(
        script_name="run",
        output_paths=["out.txt"],
    )

    assert "SKILL_SANDBOX_REQUEST_INVALID" in inline_with_args
    assert "SKILL_SANDBOX_REQUEST_INVALID" in declared_with_outputs


def test_inline_tool_description_explains_both_filesystem_modes(tmp_path: Path) -> None:
    from agent.helpudoc_agent.tools.workspace.builtins.skills import (
        build_run_skill_python_script_tool,
    )

    skills_root, workspace = _inline_workspace(tmp_path)
    settings = SimpleNamespace(backend=SimpleNamespace(skills_root=skills_root, plugins_root=None))
    tool_obj = build_run_skill_python_script_tool(settings, workspace)

    description = tool_obj.description

    assert "inline_code" in description
    assert "no\n/workspace mount" in description or "no /workspace mount" in description
    assert "read-only workspace access" in description
    assert "output_paths" in description
