from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import tarfile
import threading
from types import SimpleNamespace

import pytest

from agent.helpudoc_agent import sandbox_runner, sandbox_supervisor
from agent.helpudoc_agent.sandbox_runner import SandboxConfig, SandboxExecutionError
from agent.helpudoc_agent.sandbox_supervisor import (
    CONTROL_DIR_NAME,
    INPUT_MANIFEST_NAME,
    SandboxSupervisorError,
    _manifest_timeout_seconds,
    compute_workspace_delta,
    create_result_bundle,
    safe_extract_input_bundle,
    supervise,
)
from agent.helpudoc_agent.state import WorkspaceState
from agent.helpudoc_agent.skills_registry import activate_skill_context, load_skills


def _config() -> SandboxConfig:
    return SandboxConfig(
        namespace="helpudoc",
        image="helpudoc/agent:pinned",
        workspace_pvc="workspace-pvc",
        runtime_class_name="gvisor",
        cpu_limit="500m",
        memory_limit="512Mi",
        ephemeral_storage_limit="1Gi",
        poll_interval_seconds=0.01,
        inline_namespace="helpudoc-sandbox",
        inline_image="gcr.io/my-rd-coe-demo-gen-ai/helpudoc-inline-sandbox:pinned",
        inline_transport="object_store",
        inline_service_account="helpudoc-sandbox-runner",
    )


def test_object_store_inline_manifest_has_no_workspace_pvc_or_app_affinity() -> None:
    manifest = sandbox_runner.build_inline_sandbox_job_manifest(
        job_name="job",
        workspace_id="workspace-1",
        run_id="inline-run-1",
        timeout_seconds=120,
        sandbox_config=_config(),
        input_url="http://minio.helpudoc.svc:9000/input?signature=read",
        result_url="http://minio.helpudoc.svc:9000/result?signature=write",
    )

    assert manifest["metadata"]["namespace"] == "helpudoc-sandbox"
    pod = manifest["spec"]["template"]["spec"]
    assert pod["runtimeClassName"] == "gvisor"
    assert pod["serviceAccountName"] == "helpudoc-sandbox-runner"
    assert pod["automountServiceAccountToken"] is False
    assert pod["enableServiceLinks"] is False
    assert "affinity" not in pod
    assert all("emptyDir" in volume for volume in pod["volumes"])
    assert not any("persistentVolumeClaim" in volume for volume in pod["volumes"])
    container = pod["containers"][0]
    assert container["command"] == ["python", "/opt/helpudoc/sandbox_supervisor.py"]
    assert {mount["mountPath"] for mount in container["volumeMounts"]} == {
        "/workspace",
        "/tmp",
    }
    env = {item["name"]: item["value"] for item in container["env"]}
    assert env["HELPUDOC_WORKSPACE_ROOT"] == "/workspace"
    assert env["HELPUDOC_SANDBOX_INPUT_URL"].endswith("signature=read")
    assert env["HELPUDOC_SANDBOX_RESULT_URL"].endswith("signature=write")


def test_private_workspace_delta_round_trip_publishes_create_update_and_delete(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "deck.html").write_text("original", encoding="utf-8")
    (workspace_root / "remove.txt").write_text("remove", encoding="utf-8")
    (workspace_root / "unchanged.txt").write_text("same", encoding="utf-8")
    internal = workspace_root / "sandbox-runs" / "old"
    internal.mkdir(parents=True)
    (internal / "temporary.txt").write_text("private", encoding="utf-8")
    workspace = WorkspaceState(workspace_id="workspace-1", root_path=workspace_root)

    input_bundle = tmp_path / "input.tar"
    source_sha256, baseline = sandbox_runner._create_inline_input_bundle(
        workspace_state=workspace,
        inline_code="print('edit')\n",
        input_paths=[],
        output_paths=[],
        run_id="inline-run-1",
        destination=input_bundle,
    )
    assert "sandbox-runs/old/temporary.txt" not in baseline

    private_workspace = tmp_path / "private"
    safe_extract_input_bundle(
        input_bundle,
        private_workspace,
        max_files=600,
        max_total_bytes=1024 * 1024,
        max_file_bytes=1024 * 1024,
    )
    control = json.loads(
        (private_workspace / CONTROL_DIR_NAME / INPUT_MANIFEST_NAME).read_text(
            encoding="utf-8"
        )
    )
    assert control["baseline"] == baseline
    assert control["timeout_seconds"] == 120

    (private_workspace / "deck.html").write_text("updated", encoding="utf-8")
    (private_workspace / "remove.txt").unlink()
    (private_workspace / "created.txt").write_text("created", encoding="utf-8")
    changed, deleted = compute_workspace_delta(
        private_workspace,
        baseline,
        output_paths=[],
        max_files=64,
        max_total_bytes=1024 * 1024,
        max_file_bytes=1024 * 1024,
    )
    assert [(item["path"], item["kind"]) for item in changed] == [
        ("created.txt", "create"),
        ("deck.html", "update"),
    ]
    assert deleted == ["remove.txt"]

    result_bundle = tmp_path / "result.tar"
    create_result_bundle(
        result_bundle,
        run_id="inline-run-1",
        source_sha256=source_sha256,
        changed=changed,
        deleted=deleted,
    )
    manifest, files = sandbox_runner._safe_extract_inline_result(
        result_bundle,
        tmp_path / "result",
    )
    published, removed = sandbox_runner._publish_inline_workspace_delta(
        workspace_state=workspace,
        manifest=manifest,
        extracted_files=files,
        baseline=baseline,
        run_id="inline-run-1",
        source_sha256=source_sha256,
    )

    assert [item.path for item in published] == ["/created.txt", "/deck.html"]
    assert removed == ["remove.txt"]
    assert (workspace_root / "deck.html").read_text(encoding="utf-8") == "updated"
    assert (workspace_root / "created.txt").read_text(encoding="utf-8") == "created"
    assert not (workspace_root / "remove.txt").exists()
    assert (workspace_root / "unchanged.txt").read_text(encoding="utf-8") == "same"


def test_host_rejects_result_when_workspace_changed_after_snapshot(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "deck.html").write_text("baseline", encoding="utf-8")
    workspace = WorkspaceState(workspace_id="workspace-1", root_path=workspace_root)
    input_bundle = tmp_path / "input.tar"
    source_sha256, baseline = sandbox_runner._create_inline_input_bundle(
        workspace_state=workspace,
        inline_code="print('edit')\n",
        input_paths=[],
        output_paths=[],
        run_id="inline-conflict",
        destination=input_bundle,
    )
    private_workspace = tmp_path / "private"
    safe_extract_input_bundle(
        input_bundle,
        private_workspace,
        max_files=10,
        max_total_bytes=1024 * 1024,
        max_file_bytes=1024 * 1024,
    )
    (private_workspace / "deck.html").write_text("sandbox", encoding="utf-8")
    changed, deleted = compute_workspace_delta(
        private_workspace,
        baseline,
        output_paths=[],
        max_files=10,
        max_total_bytes=1024 * 1024,
        max_file_bytes=1024 * 1024,
    )
    result_bundle = tmp_path / "result.tar"
    create_result_bundle(
        result_bundle,
        run_id="inline-conflict",
        source_sha256=source_sha256,
        changed=changed,
        deleted=deleted,
    )
    manifest, files = sandbox_runner._safe_extract_inline_result(
        result_bundle,
        tmp_path / "result",
    )
    (workspace_root / "deck.html").write_text("concurrent", encoding="utf-8")

    with pytest.raises(SandboxExecutionError, match="INLINE_WORKSPACE_CONFLICT"):
        sandbox_runner._publish_inline_workspace_delta(
            workspace_state=workspace,
            manifest=manifest,
            extracted_files=files,
            baseline=baseline,
            run_id="inline-conflict",
            source_sha256=source_sha256,
        )
    assert (workspace_root / "deck.html").read_text(encoding="utf-8") == "concurrent"


def test_input_extractor_rejects_symlink_members(tmp_path: Path) -> None:
    archive_path = tmp_path / "malicious.tar"
    with tarfile.open(archive_path, mode="w") as archive:
        link = tarfile.TarInfo("escape")
        link.type = tarfile.SYMTYPE
        link.linkname = "../secret"
        archive.addfile(link)

    with pytest.raises(Exception, match="link or special file"):
        safe_extract_input_bundle(
            archive_path,
            tmp_path / "workspace",
            max_files=10,
            max_total_bytes=1024,
            max_file_bytes=1024,
        )


def test_object_store_orchestration_publishes_only_after_job_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SANDBOX_INLINE_ENABLED", "true")
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "demo"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: demo\ntools:\n  - run_skill_python_script\n---\n# Demo\n",
        encoding="utf-8",
    )
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "deck.html").write_text("before", encoding="utf-8")
    (workspace_root / "remove.txt").write_text("remove", encoding="utf-8")
    workspace = WorkspaceState(workspace_id="workspace-1", root_path=workspace_root)
    activate_skill_context(workspace.context, load_skills(skills_root)[0])

    class FakeStore:
        def __init__(self) -> None:
            self.objects: dict[str, Path] = {}
            self.deleted: list[str] = []

        def run_keys(self, workspace_id: str, run_id: str):
            return f"{workspace_id}/{run_id}/input.tar", f"{workspace_id}/{run_id}/result.tar"

        def upload(self, source: Path, key: str) -> None:
            target = tmp_path / key.replace("/", "-")
            shutil.copy2(source, target)
            self.objects[key] = target

        def presign_download(self, key: str) -> str:
            return f"http://minio/input?key={key}"

        def presign_upload(self, key: str) -> str:
            return f"http://minio/result?key={key}"

        def download(self, key: str, destination: Path) -> None:
            shutil.copy2(self.objects[key], destination)

        def delete(self, key: str) -> None:
            self.deleted.append(key)

    store = FakeStore()

    class FakeBatch:
        def __init__(self) -> None:
            self.namespace = ""
            self.deleted = False

        def create_namespaced_job(self, *, namespace: str, body: dict) -> None:
            self.namespace = namespace
            run_id = body["metadata"]["labels"]["helpudoc.io/sandbox-run-id"]
            input_key, result_key = store.run_keys("workspace-1", run_id)
            private = tmp_path / "private-job"
            safe_extract_input_bundle(
                store.objects[input_key],
                private,
                max_files=600,
                max_total_bytes=1024 * 1024,
                max_file_bytes=1024 * 1024,
            )
            control = json.loads(
                (private / CONTROL_DIR_NAME / INPUT_MANIFEST_NAME).read_text(encoding="utf-8")
            )
            (private / "deck.html").write_text("after", encoding="utf-8")
            (private / "remove.txt").unlink()
            changed, deleted = compute_workspace_delta(
                private,
                control["baseline"],
                output_paths=control["output_paths"],
                max_files=64,
                max_total_bytes=1024 * 1024,
                max_file_bytes=1024 * 1024,
            )
            result = tmp_path / "simulated-result.tar"
            create_result_bundle(
                result,
                run_id=run_id,
                source_sha256=control["source_sha256"],
                changed=changed,
                deleted=deleted,
            )
            store.objects[result_key] = result

        def read_namespaced_job_status(self, *, name: str, namespace: str):
            return SimpleNamespace(status=SimpleNamespace(succeeded=1, failed=0))

        def delete_namespaced_job(self, *, name: str, namespace: str, propagation_policy: str):
            self.deleted = True

    class FakeCore:
        def list_namespaced_pod(self, *, namespace: str, label_selector: str):
            return SimpleNamespace(
                items=[SimpleNamespace(metadata=SimpleNamespace(name="sandbox-pod"))]
            )

        def read_namespaced_pod_log(
            self, *, name: str, namespace: str, container: str, tail_lines: int
        ) -> str:
            return '{"status":"ok"}'

    batch = FakeBatch()
    result = sandbox_runner.run_inline_python_in_kubernetes(
        skills_root=skills_root,
        workspace_state=workspace,
        inline_code="print('simulated by fake job')\n",
        output_paths=[],
        batch_api=batch,
        core_api=FakeCore(),
        sandbox_config=_config(),
        object_store=store,
    )

    assert batch.namespace == "helpudoc-sandbox"
    assert batch.deleted is True
    assert (workspace_root / "deck.html").read_text(encoding="utf-8") == "after"
    assert not (workspace_root / "remove.txt").exists()
    assert [item.path for item in result.output_files] == ["/deck.html"]
    assert result.deleted_files == ["/remove.txt"]
    assert len(store.deleted) == 2


def test_supervisor_downloads_executes_and_uploads_with_scoped_http_transfer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_workspace = tmp_path / "source"
    source_workspace.mkdir()
    (source_workspace / "input.txt").write_text("hello", encoding="utf-8")
    workspace = WorkspaceState(workspace_id="workspace-http", root_path=source_workspace)
    input_bundle = tmp_path / "input.tar"
    sandbox_runner._create_inline_input_bundle(
        workspace_state=workspace,
        inline_code=(
            "import os\nfrom pathlib import Path\n"
            "root = Path(os.environ['HELPUDOC_WORKSPACE_ROOT'])\n"
            "(root / 'result.txt').write_text((root / 'input.txt').read_text() + ' world')\n"
        ),
        input_paths=[],
        output_paths=[],
        run_id="inline-http",
        destination=input_bundle,
        timeout_seconds=7,
    )
    uploaded: dict[str, bytes] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - stdlib callback name
            payload = input_bundle.read_bytes()
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_PUT(self):  # noqa: N802 - stdlib callback name
            size = int(self.headers.get("Content-Length") or 0)
            uploaded["result"] = self.rfile.read(size)
            self.send_response(200)
            self.end_headers()

        def log_message(self, _format, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        execution_root = tmp_path / "execution"
        monkeypatch.setenv("HELPUDOC_WORKSPACE_ROOT", str(execution_root))
        monkeypatch.setenv("HELPUDOC_SANDBOX_INPUT_URL", f"http://127.0.0.1:{port}/input")
        monkeypatch.setenv("HELPUDOC_SANDBOX_RESULT_URL", f"http://127.0.0.1:{port}/result")
        monkeypatch.setenv("HELPUDOC_SANDBOX_MAX_TRANSFER_BYTES", str(2 * 1024 * 1024))
        monkeypatch.setenv("HELPUDOC_SANDBOX_MAX_INPUT_BYTES", str(1024 * 1024))
        monkeypatch.setenv("HELPUDOC_SANDBOX_MAX_OUTPUT_BYTES", str(1024 * 1024))
        monkeypatch.setenv("HELPUDOC_SANDBOX_MAX_FILE_BYTES", str(1024 * 1024))

        original_run = sandbox_supervisor.subprocess.run
        observed: dict[str, int] = {}

        def run_with_timeout(*args, **kwargs):
            observed["timeout"] = kwargs.get("timeout")
            return original_run(*args, **kwargs)

        monkeypatch.setattr(sandbox_supervisor.subprocess, "run", run_with_timeout)
        assert supervise() == 0
        assert observed == {"timeout": 7}
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    result_bundle = tmp_path / "uploaded-result.tar"
    result_bundle.write_bytes(uploaded["result"])
    manifest, files = sandbox_runner._safe_extract_inline_result(
        result_bundle,
        tmp_path / "uploaded-result",
    )
    assert manifest["files"] == [
        {
            "kind": "create",
            "path": "result.txt",
            "sha256": sandbox_runner._sha256_file(files["result.txt"]),
            "size": 11,
        }
    ]
    assert files["result.txt"].read_text(encoding="utf-8") == "hello world"


def test_supervisor_manifest_timeout_is_strictly_bounded() -> None:
    assert _manifest_timeout_seconds({"timeout_seconds": 1}) == 1
    assert _manifest_timeout_seconds({"timeout_seconds": "300"}) == 300
    for value in (None, True, 0, 301, "invalid"):
        with pytest.raises(SandboxSupervisorError, match="execution timeout"):
            _manifest_timeout_seconds({"timeout_seconds": value})
