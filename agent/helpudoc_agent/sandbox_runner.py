"""Kubernetes-backed execution for declared skill scripts and inline agent code."""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import logging
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import threading
import time
from typing import Any, Iterable, Iterator, List, Sequence
from uuid import uuid4

from .config.env import load_sandbox_k8s_env
from .skills_registry import SkillMetadata, SkillSandboxScript, find_skill_for_context, resolve_skill_scope
from .state import WorkspaceState

logger = logging.getLogger(__name__)

# --- Inline sandbox limits (Gate B, section 6.2 of the execution spec) -------
INLINE_RUN_ID_PREFIX = "inline-"
INLINE_ENTRYPOINT_NAME = "inline_main.py"
INLINE_MAX_SOURCE_BYTES = 64 * 1024
INLINE_MAX_INPUT_FILES = 16
INLINE_MAX_OUTPUT_FILES = 16
INLINE_MAX_OUTPUT_BYTES = 100 * 1024 * 1024
INLINE_MAX_TOTAL_OUTPUT_BYTES = 256 * 1024 * 1024
INLINE_DEFAULT_TIMEOUT_SECONDS = 120
INLINE_MAX_TIMEOUT_SECONDS = 300
INLINE_MAX_STDOUT_BYTES = 64 * 1024
INLINE_MAX_STDERR_BYTES = 32 * 1024
INLINE_MAX_EXECUTIONS_PER_AGENT_RUN = 2
INLINE_MAX_ACTIVE_JOBS_PER_WORKSPACE = 1
INLINE_DEFAULT_GLOBAL_JOB_CEILING = 4
INLINE_STALE_RUN_DIR_AGE_SECONDS = 3600
INLINE_EXECUTIONS_CONTEXT_KEY = "_inline_sandbox_executions"
INLINE_RUN_MARKER_NAME = ".helpudoc-inline-run"


class SandboxExecutionError(RuntimeError):
    """Raised when a sandbox run is invalid or fails."""


class SandboxUnavailableError(SandboxExecutionError):
    """Raised when Kubernetes execution is not configured for this process."""


class InlineSandboxDisabledError(SandboxUnavailableError):
    """Raised when inline execution is requested while its feature flag is off."""


class InlineWorkspaceUnavailableError(SandboxExecutionError):
    """Raised when an inline request references the absent /workspace mount."""


@dataclass(frozen=True)
class SandboxOutputFile:
    path: str
    size: int


@dataclass(frozen=True)
class SandboxRunResult:
    run_id: str
    job_name: str
    stdout: str
    stderr: str
    output_files: List[SandboxOutputFile]
    mode: str = "declared"
    source_sha256: str | None = None


@dataclass(frozen=True)
class SandboxConfig:
    namespace: str
    image: str
    workspace_pvc: str
    runtime_class_name: str
    cpu_limit: str
    memory_limit: str
    ephemeral_storage_limit: str
    poll_interval_seconds: float

    @classmethod
    def from_env(cls) -> "SandboxConfig":
        e = load_sandbox_k8s_env()
        return cls(
            namespace=e.namespace,
            image=e.image,
            workspace_pvc=e.workspace_pvc,
            runtime_class_name=e.runtime_class_name,
            cpu_limit=e.cpu_limit,
            memory_limit=e.memory_limit,
            ephemeral_storage_limit=e.ephemeral_storage_limit,
            poll_interval_seconds=e.poll_interval_seconds,
        )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_relative_safe(value: str) -> bool:
    path = Path(value)
    return bool(value.strip()) and not path.is_absolute() and ".." not in path.parts


def _safe_workspace_path(root: Path, raw_path: str) -> Path:
    cleaned = str(raw_path or "").strip().replace("\\", "/")
    if not cleaned:
        raise SandboxExecutionError("input_paths cannot contain empty paths.")
    rel = cleaned.lstrip("/")
    if not _is_relative_safe(rel):
        raise SandboxExecutionError(f"Input path is outside the workspace: {raw_path}")
    candidate = (root / rel).resolve()
    root_resolved = root.resolve()
    if candidate != root_resolved and root_resolved not in candidate.parents:
        raise SandboxExecutionError(f"Input path is outside the workspace: {raw_path}")
    if not candidate.is_file():
        raise SandboxExecutionError(f"Input file does not exist: {raw_path}")
    return candidate


def _safe_declared_output(raw_path: str) -> Path:
    cleaned = str(raw_path or "").strip().replace("\\", "/")
    if not _is_relative_safe(cleaned):
        raise SandboxExecutionError(f"Declared output path must be relative and stay inside the run directory: {raw_path}")
    return Path(cleaned)


def _safe_subpath_segment(raw_value: str, label: str) -> str:
    value = str(raw_value or "").strip()
    if not value or "/" in value or "\\" in value or value in {".", ".."}:
        raise SandboxExecutionError(f"{label} must be a single safe path segment.")
    return value


def _chmod_best_effort(path: Path, mode: int) -> None:
    try:
        path.chmod(mode)
    except Exception:
        logger.debug("Failed chmod for sandbox path %s", path, exc_info=True)


def _ignore_script_cache_dirs(_dir: str, names: list[str]) -> set[str]:
    return {name for name in names if name == "__pycache__" or name.endswith(".pyc")}


def _resolve_script(
    skill: SkillMetadata,
    script_name: str,
    *,
    plugins_root: Path | None = None,
) -> SkillSandboxScript:
    normalized = str(script_name or "").strip()
    if not normalized:
        raise SandboxExecutionError("script_name is required.")
    scope = resolve_skill_scope(skill, plugins_root=plugins_root)
    for script in scope.sandbox_scripts:
        if script.name == normalized:
            return script
    raise SandboxExecutionError(
        f"Script '{normalized}' is not declared in sandbox_scripts for skill '{skill.skill_id}'."
    )


def _resolve_skill(
    *,
    skills_root: Path | None,
    workspace_state: WorkspaceState,
) -> SkillMetadata:
    if skills_root is None or not skills_root.exists():
        raise SandboxExecutionError("No skills directory configured.")
    active_skill_id = str(workspace_state.context.get("active_skill") or "").strip()
    if not active_skill_id:
        active_scope = workspace_state.context.get("active_skill_scope")
        if isinstance(active_scope, dict):
            active_skill_id = str(active_scope.get("skill_id") or "").strip()
    if not active_skill_id:
        raise SandboxExecutionError("Load a skill before running a skill script.")
    skill = find_skill_for_context(skills_root, active_skill_id, workspace_state.context)
    if skill is None:
        raise SandboxExecutionError(f"Active skill '{active_skill_id}' was not found in the skills registry.")
    return skill


def _stage_run(
    *,
    workspace_state: WorkspaceState,
    skill: SkillMetadata,
    script: SkillSandboxScript,
    input_paths: Iterable[str],
) -> tuple[str, Path, Path]:
    script_source_dir = (script.source_dir or skill.path.parent).resolve()
    script_rel = str(script.path or "").strip().replace("\\", "/")
    if not _is_relative_safe(script_rel):
        raise SandboxExecutionError(f"Script path for '{script.name}' must be relative to its source directory.")
    script_path = (script_source_dir / script_rel).resolve()
    if script_path != script_source_dir and script_source_dir not in script_path.parents:
        raise SandboxExecutionError(f"Script path for '{script.name}' escapes its source directory.")
    if not script_path.is_file():
        raise SandboxExecutionError(f"Declared script file does not exist: {script.path}")
    actual_hash = _sha256_file(script_path)
    if actual_hash.lower() != script.sha256.lower():
        raise SandboxExecutionError(
            f"Script hash mismatch for '{script.name}': expected {script.sha256}, got {actual_hash}."
        )

    run_id = uuid4().hex
    run_dir = workspace_state.root_path / "sandbox-runs" / run_id
    scripts_dir = run_dir / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=False)
    (run_dir / "tmp").mkdir(parents=True, exist_ok=True)
    (run_dir / "workspace-output").mkdir(parents=True, exist_ok=True)
    _chmod_best_effort(run_dir, 0o777)
    _chmod_best_effort(scripts_dir, 0o755)
    _chmod_best_effort(run_dir / "tmp", 0o777)
    _chmod_best_effort(run_dir / "workspace-output", 0o777)

    source_scripts_dir = script_source_dir / "scripts"
    if source_scripts_dir.is_dir() and (
        script_path == source_scripts_dir or source_scripts_dir in script_path.parents
    ):
        shutil.rmtree(scripts_dir)
        shutil.copytree(source_scripts_dir, scripts_dir, ignore=_ignore_script_cache_dirs)
        staged_script = run_dir / script_path.relative_to(script_source_dir)
    else:
        staged_script = scripts_dir / script_path.name
        shutil.copy2(script_path, staged_script)
    _chmod_best_effort(staged_script, 0o555)

    copied_names: set[str] = set()
    for raw_input in input_paths or []:
        source = _safe_workspace_path(workspace_state.root_path, str(raw_input))
        name = source.name
        if name in copied_names:
            raise SandboxExecutionError(f"Input file basename collision is not allowed: {name}")
        copied_names.add(name)
        staged_input = run_dir / name
        shutil.copy2(source, staged_input)
        _chmod_best_effort(staged_input, 0o444)

    for raw_output in script.outputs:
        output_rel = _safe_declared_output(raw_output)
        output_parent = (run_dir / output_rel).parent
        output_parent.mkdir(parents=True, exist_ok=True)
        _chmod_best_effort(output_parent, 0o777)

    return run_id, run_dir, staged_script


def _safe_copy_workspace_outputs(workspace_state: WorkspaceState, run_dir: Path) -> None:
    source_root = (run_dir / "workspace-output").resolve()
    if not source_root.is_dir():
        return
    workspace_root = workspace_state.root_path.resolve()
    for source in sorted(source_root.rglob("*")):
        if not source.is_file():
            continue
        relative = source.relative_to(source_root)
        if not _is_relative_safe(relative.as_posix()):
            raise SandboxExecutionError(f"Workspace output path is unsafe: {relative.as_posix()}")
        destination = (workspace_root / relative).resolve()
        if destination != workspace_root and workspace_root not in destination.parents:
            raise SandboxExecutionError(f"Workspace output path escapes workspace: {relative.as_posix()}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def _collect_declared_outputs(run_dir: Path, script: SkillSandboxScript) -> List[SandboxOutputFile]:
    outputs: List[SandboxOutputFile] = []
    for raw_output in script.outputs:
        output_rel = _safe_declared_output(raw_output)
        output_path = run_dir / output_rel
        if output_path.is_file():
            outputs.append(
                SandboxOutputFile(
                    path=f"/sandbox-runs/{run_dir.name}/{output_rel.as_posix()}",
                    size=output_path.stat().st_size,
                )
            )
    return outputs


def _load_kubernetes_clients() -> tuple[Any, Any]:
    try:
        from kubernetes import client, config
    except Exception as exc:  # pragma: no cover - optional dependency guard
        raise SandboxUnavailableError("Kubernetes Python client is not installed.") from exc

    try:
        config.load_incluster_config()
    except Exception as incluster_exc:
        if not load_sandbox_k8s_env().allow_kubeconfig:
            raise SandboxUnavailableError(
                "Skill sandbox is disabled: Kubernetes in-cluster config is unavailable."
            ) from incluster_exc
        try:
            config.load_kube_config()
        except Exception as kubeconfig_exc:
            raise SandboxUnavailableError(
                "Skill sandbox is disabled: Kubernetes config is unavailable."
            ) from kubeconfig_exc

    return client.BatchV1Api(), client.CoreV1Api()


def build_sandbox_job_manifest(
    *,
    job_name: str,
    workspace_id: str,
    run_id: str,
    staged_script_name: str,
    args: List[str],
    script: SkillSandboxScript,
    sandbox_config: SandboxConfig,
) -> dict[str, Any]:
    labels = {
        "app": "helpudoc-skill-sandbox",
        "helpudoc.io/workspace-id": workspace_id,
        "helpudoc.io/sandbox-run-id": run_id,
    }
    safe_workspace_id = _safe_subpath_segment(workspace_id, "workspace_id")
    safe_run_id = _safe_subpath_segment(run_id, "run_id")
    timeout_seconds = max(1, int(script.timeout_seconds))
    staged_script_path = str(staged_script_name or "").strip().replace("\\", "/")
    if "/" not in staged_script_path:
        staged_script_path = f"scripts/{staged_script_path}"
    if not _is_relative_safe(staged_script_path):
        raise SandboxExecutionError("staged_script_name must be a safe relative path.")
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": job_name,
            "namespace": sandbox_config.namespace,
            "labels": labels,
        },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": timeout_seconds + 30,
            "ttlSecondsAfterFinished": 300,
            "template": {
                "metadata": {"labels": labels},
                "spec": {
                    "restartPolicy": "Never",
                    "runtimeClassName": sandbox_config.runtime_class_name,
                    "automountServiceAccountToken": False,
                    "securityContext": {
                        "runAsNonRoot": True,
                        "runAsUser": 1000,
                        "runAsGroup": 1000,
                        "fsGroup": 1000,
                        "seccompProfile": {"type": "RuntimeDefault"},
                    },
                    "containers": [
                        {
                            "name": "runner",
                            "image": sandbox_config.image,
                            "imagePullPolicy": "IfNotPresent",
                            "workingDir": "/sandbox",
                            "command": ["python", f"/sandbox/{staged_script_path}"],
                            "args": args,
                            "env": [
                                {"name": "PYTHONDONTWRITEBYTECODE", "value": "1"},
                                {"name": "TMPDIR", "value": "/sandbox/tmp"},
                                {"name": "HOME", "value": "/sandbox/tmp"},
                                {"name": "PYTHONPATH", "value": "/sandbox/scripts:/sandbox"},
                                {"name": "HELPUDOC_WORKSPACE_ID", "value": safe_workspace_id},
                                {"name": "HELPUDOC_WORKSPACE_ROOT", "value": "/workspace"},
                                {"name": "HELPUDOC_WORKSPACE_OUTPUT_ROOT", "value": "/sandbox/workspace-output"},
                                {"name": "HELPUDOC_SANDBOX_RUN_DIR", "value": "/sandbox"},
                            ],
                            "resources": {
                                "limits": {
                                    "cpu": sandbox_config.cpu_limit,
                                    "memory": sandbox_config.memory_limit,
                                    "ephemeral-storage": sandbox_config.ephemeral_storage_limit,
                                },
                                "requests": {
                                    "cpu": "100m",
                                    "memory": "128Mi",
                                    "ephemeral-storage": "128Mi",
                                },
                            },
                            "securityContext": {
                                "allowPrivilegeEscalation": False,
                                "readOnlyRootFilesystem": True,
                                "capabilities": {"drop": ["ALL"]},
                            },
                            "volumeMounts": [
                                {
                                    "name": "sandbox-workspace",
                                    "mountPath": "/sandbox",
                                    "subPath": f"{safe_workspace_id}/sandbox-runs/{safe_run_id}",
                                },
                                {
                                    "name": "sandbox-workspace",
                                    "mountPath": "/workspace",
                                    "subPath": safe_workspace_id,
                                    "readOnly": True,
                                }
                            ],
                        }
                    ],
                    "volumes": [
                        {
                            "name": "sandbox-workspace",
                            "persistentVolumeClaim": {"claimName": sandbox_config.workspace_pvc},
                        }
                    ],
                },
            },
        },
    }


def _clip_utf8(text: str, max_bytes: int | None) -> str:
    if max_bytes is None:
        return text
    return text.encode("utf-8")[:max_bytes].decode("utf-8", errors="ignore")


def _collect_logs(
    core_api: Any,
    *,
    namespace: str,
    job_name: str,
    max_stdout_bytes: int | None = None,
    max_stderr_bytes: int | None = None,
) -> tuple[str, str]:
    selector = f"job-name={job_name}"
    try:
        pods = core_api.list_namespaced_pod(namespace=namespace, label_selector=selector)
    except Exception:
        logger.exception("Failed listing sandbox pods for %s", job_name)
        return "", ""
    stdout_parts: list[str] = []
    for pod in getattr(pods, "items", []) or []:
        pod_name = getattr(getattr(pod, "metadata", None), "name", "")
        if not pod_name:
            continue
        try:
            stdout_parts.append(
                core_api.read_namespaced_pod_log(
                    name=pod_name,
                    namespace=namespace,
                    container="runner",
                    tail_lines=400,
                )
                or ""
            )
        except Exception:
            logger.exception("Failed reading sandbox pod logs for %s", pod_name)
    stdout = "\n".join(part for part in stdout_parts if part).strip()
    return _clip_utf8(stdout, max_stdout_bytes), _clip_utf8("", max_stderr_bytes)


def _wait_for_job(
    batch_api: Any,
    core_api: Any,
    *,
    namespace: str,
    job_name: str,
    timeout_seconds: int,
    poll_interval_seconds: float,
    max_stdout_bytes: int | None = None,
    max_stderr_bytes: int | None = None,
) -> tuple[str, str]:
    deadline = time.monotonic() + timeout_seconds + 45
    while time.monotonic() < deadline:
        status = batch_api.read_namespaced_job_status(name=job_name, namespace=namespace).status
        if int(getattr(status, "succeeded", 0) or 0) > 0:
            return _collect_logs(
                core_api,
                namespace=namespace,
                job_name=job_name,
                max_stdout_bytes=max_stdout_bytes,
                max_stderr_bytes=max_stderr_bytes,
            )
        if int(getattr(status, "failed", 0) or 0) > 0:
            stdout, stderr = _collect_logs(
                core_api,
                namespace=namespace,
                job_name=job_name,
                max_stdout_bytes=max_stdout_bytes,
                max_stderr_bytes=max_stderr_bytes,
            )
            raise SandboxExecutionError(
                f"Sandbox job '{job_name}' failed.\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}".strip()
            )
        time.sleep(poll_interval_seconds)
    stdout, stderr = _collect_logs(
        core_api,
        namespace=namespace,
        job_name=job_name,
        max_stdout_bytes=max_stdout_bytes,
        max_stderr_bytes=max_stderr_bytes,
    )
    raise SandboxExecutionError(
        f"Sandbox job '{job_name}' timed out.\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}".strip()
    )


def run_skill_python_script_in_kubernetes(
    *,
    skills_root: Path | None,
    plugins_root: Path | None = None,
    workspace_state: WorkspaceState,
    script_name: str,
    input_paths: Iterable[str] | None = None,
    args: Iterable[str] | None = None,
    batch_api: Any | None = None,
    core_api: Any | None = None,
    sandbox_config: SandboxConfig | None = None,
) -> SandboxRunResult:
    skill = _resolve_skill(skills_root=skills_root, workspace_state=workspace_state)
    script = _resolve_script(skill, script_name, plugins_root=plugins_root)
    run_id, run_dir, staged_script = _stage_run(
        workspace_state=workspace_state,
        skill=skill,
        script=script,
        input_paths=input_paths or [],
    )
    safe_args = [str(item) for item in (args or [])]
    sandbox_config = sandbox_config or SandboxConfig.from_env()
    if batch_api is None or core_api is None:
        batch_api, core_api = _load_kubernetes_clients()

    job_name = f"helpudoc-sandbox-{run_id[:24]}"
    manifest = build_sandbox_job_manifest(
        job_name=job_name,
        workspace_id=workspace_state.workspace_id,
        run_id=run_id,
        staged_script_name=staged_script.relative_to(run_dir).as_posix(),
        args=safe_args,
        script=script,
        sandbox_config=sandbox_config,
    )
    try:
        batch_api.create_namespaced_job(namespace=sandbox_config.namespace, body=manifest)
        stdout, stderr = _wait_for_job(
            batch_api,
            core_api,
            namespace=sandbox_config.namespace,
            job_name=job_name,
            timeout_seconds=script.timeout_seconds,
            poll_interval_seconds=sandbox_config.poll_interval_seconds,
        )
    finally:
        try:
            batch_api.delete_namespaced_job(
                name=job_name,
                namespace=sandbox_config.namespace,
                propagation_policy="Background",
            )
        except Exception:
            logger.info("Sandbox job cleanup skipped or failed for %s", job_name, exc_info=True)

    _safe_copy_workspace_outputs(workspace_state, run_dir)
    outputs = _collect_declared_outputs(run_dir, script)
    return SandboxRunResult(
        run_id=run_id,
        job_name=job_name,
        stdout=stdout,
        stderr=stderr,
        output_files=outputs,
    )


def run_skill_python_script_locally(
    *,
    skills_root: Path | None,
    plugins_root: Path | None = None,
    workspace_state: WorkspaceState,
    script_name: str,
    input_paths: Iterable[str] | None = None,
    args: Iterable[str] | None = None,
) -> SandboxRunResult:
    skill = _resolve_skill(skills_root=skills_root, workspace_state=workspace_state)
    script = _resolve_script(skill, script_name, plugins_root=plugins_root)
    run_id, run_dir, staged_script = _stage_run(
        workspace_state=workspace_state,
        skill=skill,
        script=script,
        input_paths=input_paths or [],
    )
    env = os.environ.copy()
    package_root = Path(__file__).resolve().parent
    agent_root = package_root.parent
    repo_root = agent_root.parent
    existing_pythonpath = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = os.pathsep.join(
        part
        for part in [
            str(repo_root),
            str(agent_root),
            str(run_dir / "scripts"),
            str(run_dir),
            existing_pythonpath,
        ]
        if part
    )
    env.update(
        {
            "PYTHONDONTWRITEBYTECODE": "1",
            "TMPDIR": str(run_dir / "tmp"),
            "HOME": str(run_dir / "tmp"),
            "HELPUDOC_WORKSPACE_ID": workspace_state.workspace_id,
            "HELPUDOC_WORKSPACE_ROOT": str(workspace_state.root_path.resolve()),
            "HELPUDOC_WORKSPACE_OUTPUT_ROOT": str((run_dir / "workspace-output").resolve()),
            "HELPUDOC_SANDBOX_RUN_DIR": str(run_dir.resolve()),
        }
    )
    safe_args = [str(item) for item in (args or [])]
    completed = subprocess.run(
        [sys.executable, str(staged_script), *safe_args],
        cwd=str(run_dir),
        env=env,
        text=True,
        capture_output=True,
        timeout=max(1, int(script.timeout_seconds)),
        check=False,
    )
    if completed.returncode != 0:
        raise SandboxExecutionError(
            (
                f"Local sandbox script '{script.name}' failed with exit code {completed.returncode}.\n"
                f"STDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}"
            ).strip()
        )
    _safe_copy_workspace_outputs(workspace_state, run_dir)
    return SandboxRunResult(
        run_id=run_id,
        job_name=f"local-{run_id[:24]}",
        stdout=(completed.stdout or "").strip(),
        stderr=(completed.stderr or "").strip(),
        output_files=_collect_declared_outputs(run_dir, script),
    )


def _resolve_sandbox_backend() -> str:
    raw = (os.getenv("HELPUDOC_SANDBOX_BACKEND") or "auto").strip().lower()
    if raw not in {"local", "kubernetes", "auto"}:
        raise SandboxExecutionError("HELPUDOC_SANDBOX_BACKEND must be local, kubernetes, or auto.")
    if raw == "auto":
        return "kubernetes" if os.getenv("KUBERNETES_SERVICE_HOST") else "local"
    return raw


# --- Inline agent-authored Python -------------------------------------------


def inline_sandbox_enabled() -> bool:
    """Inline execution is opt-in; SANDBOX_INLINE_ENABLED defaults to false."""
    raw = (os.getenv("SANDBOX_INLINE_ENABLED") or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def inline_global_job_ceiling() -> int:
    raw = (os.getenv("SANDBOX_INLINE_MAX_GLOBAL_JOBS") or "").strip()
    if not raw:
        return INLINE_DEFAULT_GLOBAL_JOB_CEILING
    try:
        value = int(raw)
    except ValueError as exc:
        raise SandboxExecutionError(
            "SANDBOX_INLINE_MAX_GLOBAL_JOBS must be a positive integer."
        ) from exc
    if value < 1:
        raise SandboxExecutionError("SANDBOX_INLINE_MAX_GLOBAL_JOBS must be a positive integer.")
    return value


_INLINE_JOB_LOCK = threading.Lock()
_INLINE_ACTIVE_JOBS: dict[str, int] = {}


def reset_inline_job_accounting_for_tests() -> None:
    with _INLINE_JOB_LOCK:
        _INLINE_ACTIVE_JOBS.clear()


@contextmanager
def _inline_job_slot(workspace_id: str, *, global_ceiling: int) -> Iterator[None]:
    key = str(workspace_id or "").strip() or "unknown"
    with _INLINE_JOB_LOCK:
        active_for_workspace = _INLINE_ACTIVE_JOBS.get(key, 0)
        if active_for_workspace >= INLINE_MAX_ACTIVE_JOBS_PER_WORKSPACE:
            raise SandboxExecutionError(
                "INLINE_WORKSPACE_JOB_LIMIT_REACHED: an inline sandbox Job is already active for "
                "this workspace. Wait for it to finish before starting another."
            )
        if sum(_INLINE_ACTIVE_JOBS.values()) >= global_ceiling:
            raise SandboxExecutionError(
                "INLINE_GLOBAL_JOB_LIMIT_REACHED: the inline sandbox Job ceiling for this agent "
                f"({global_ceiling}) is fully used. Retry after a running job completes."
            )
        _INLINE_ACTIVE_JOBS[key] = active_for_workspace + 1
    try:
        yield
    finally:
        with _INLINE_JOB_LOCK:
            remaining = _INLINE_ACTIVE_JOBS.get(key, 1) - 1
            if remaining > 0:
                _INLINE_ACTIVE_JOBS[key] = remaining
            else:
                _INLINE_ACTIVE_JOBS.pop(key, None)


def _reserve_inline_execution(workspace_state: WorkspaceState) -> None:
    with _INLINE_JOB_LOCK:
        used = int(workspace_state.context.get(INLINE_EXECUTIONS_CONTEXT_KEY) or 0)
        if used >= INLINE_MAX_EXECUTIONS_PER_AGENT_RUN:
            raise SandboxExecutionError(
                "INLINE_EXECUTION_LIMIT_REACHED: this agent run already used its "
                f"{INLINE_MAX_EXECUTIONS_PER_AGENT_RUN} inline sandbox executions. Use a declared "
                "skill script or report the limit."
            )
        workspace_state.context[INLINE_EXECUTIONS_CONTEXT_KEY] = used + 1


def _reject_workspace_mount_path(raw_path: str, *, field: str) -> str:
    """Reject `/workspace` requests; inline Jobs have no workspace mount."""
    cleaned = str(raw_path or "").strip().replace("\\", "/")
    probe = cleaned.rstrip("/") or cleaned
    if probe == "/workspace" or cleaned.startswith("/workspace/"):
        raise InlineWorkspaceUnavailableError(
            f"INLINE_WORKSPACE_UNAVAILABLE: {field} may not reference /workspace. Inline code runs "
            "without a workspace mount; request workspace-relative paths and read staged inputs by "
            "filename from the run directory."
        )
    return cleaned


def _normalize_inline_outputs(output_paths: Iterable[str] | None) -> List[Path]:
    raw_items = [str(item) for item in (output_paths or [])]
    if not raw_items:
        raise SandboxExecutionError(
            "INLINE_OUTPUTS_REQUIRED: inline_code requires explicit output_paths; only declared "
            "outputs are published."
        )
    if len(raw_items) > INLINE_MAX_OUTPUT_FILES:
        raise SandboxExecutionError(
            f"INLINE_OUTPUT_LIMIT_EXCEEDED: at most {INLINE_MAX_OUTPUT_FILES} output paths are allowed."
        )
    normalized: List[Path] = []
    seen: set[str] = set()
    for raw in raw_items:
        cleaned = _reject_workspace_mount_path(raw, field="output_paths")
        rel = Path(cleaned)
        if not _is_relative_safe(cleaned) or rel == Path("."):
            raise SandboxExecutionError(
                f"Declared output path must be relative and stay inside the run directory: {raw}"
            )
        if rel.parts[0] in {"scripts", "tmp", INLINE_RUN_MARKER_NAME}:
            raise SandboxExecutionError(
                f"Declared output path overlaps a sandbox control path: {raw}"
            )
        key = rel.as_posix()
        if key in seen:
            raise SandboxExecutionError(f"Duplicate output path is not allowed: {raw}")
        seen.add(key)
        normalized.append(rel)
    return normalized


def _normalize_inline_inputs(input_paths: Iterable[str] | None) -> List[str]:
    raw_items = [str(item) for item in (input_paths or [])]
    if len(raw_items) > INLINE_MAX_INPUT_FILES:
        raise SandboxExecutionError(
            f"INLINE_INPUT_LIMIT_EXCEEDED: at most {INLINE_MAX_INPUT_FILES} input paths are allowed."
        )
    normalized: List[str] = []
    for raw in raw_items:
        cleaned = _reject_workspace_mount_path(raw, field="input_paths")
        if not _is_relative_safe(cleaned):
            raise SandboxExecutionError(f"Input path is outside the workspace: {raw}")
        normalized.append(cleaned)
    return normalized


def _resolve_inline_timeout(timeout_seconds: int | float | None) -> int:
    if timeout_seconds is None:
        return INLINE_DEFAULT_TIMEOUT_SECONDS
    try:
        value = int(timeout_seconds)
    except (TypeError, ValueError) as exc:
        raise SandboxExecutionError("timeout_seconds must be an integer number of seconds.") from exc
    if value < 1:
        raise SandboxExecutionError("timeout_seconds must be at least 1 second.")
    if value > INLINE_MAX_TIMEOUT_SECONDS:
        raise SandboxExecutionError(
            f"INLINE_TIMEOUT_TOO_LARGE: timeout_seconds may not exceed {INLINE_MAX_TIMEOUT_SECONDS}."
        )
    return value


def _stage_inline_run(
    *,
    workspace_state: WorkspaceState,
    inline_code: str,
    input_paths: Sequence[str],
    output_paths: Sequence[Path],
) -> tuple[str, Path, str]:
    source = str(inline_code or "")
    if not source.strip():
        raise SandboxExecutionError("inline_code cannot be empty.")
    encoded = source.encode("utf-8")
    if len(encoded) > INLINE_MAX_SOURCE_BYTES:
        raise SandboxExecutionError(
            "INLINE_SOURCE_TOO_LARGE: inline_code exceeds "
            f"{INLINE_MAX_SOURCE_BYTES} bytes ({len(encoded)} bytes supplied)."
        )
    source_sha256 = hashlib.sha256(encoded).hexdigest()

    output_keys = {item.as_posix() for item in output_paths}
    staged_sources: list[tuple[Path, Path, bool]] = []
    copied_names: set[str] = set()
    for raw_input in input_paths:
        source_file = _safe_workspace_path(workspace_state.root_path, raw_input)
        input_rel = Path(raw_input)
        in_place = input_rel.as_posix() in output_keys
        staged_rel = input_rel if in_place else Path(source_file.name)
        key = staged_rel.as_posix()
        if key in copied_names:
            raise SandboxExecutionError(f"Input staging path collision is not allowed: {key}")
        copied_names.add(key)
        staged_sources.append((source_file, staged_rel, in_place))

    run_id = f"{INLINE_RUN_ID_PREFIX}{uuid4().hex}"
    run_dir = workspace_state.root_path / "sandbox-runs" / run_id
    scripts_dir = run_dir / "scripts"
    try:
        scripts_dir.mkdir(parents=True, exist_ok=False)
        (run_dir / "tmp").mkdir(parents=True, exist_ok=True)
        (run_dir / INLINE_RUN_MARKER_NAME).write_text(source_sha256 + "\n", encoding="utf-8")
        _chmod_best_effort(run_dir, 0o777)
        _chmod_best_effort(scripts_dir, 0o755)
        _chmod_best_effort(run_dir / "tmp", 0o777)

        entrypoint = scripts_dir / INLINE_ENTRYPOINT_NAME
        entrypoint.write_bytes(encoded)
        _chmod_best_effort(entrypoint, 0o555)

        for source_file, staged_rel, in_place in staged_sources:
            staged_input = run_dir / staged_rel
            staged_input.parent.mkdir(parents=True, exist_ok=True)
            _chmod_best_effort(staged_input.parent, 0o777)
            shutil.copy2(source_file, staged_input)
            _chmod_best_effort(staged_input, 0o666 if in_place else 0o444)

        for output_rel in output_paths:
            output_parent = (run_dir / output_rel).parent
            output_parent.mkdir(parents=True, exist_ok=True)
            _chmod_best_effort(output_parent, 0o777)
    except Exception:
        _remove_inline_run_dir(run_dir)
        raise

    return run_id, run_dir, source_sha256


def _assert_no_symlink_components(run_dir: Path, relative: Path) -> None:
    current = run_dir
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise SandboxExecutionError(
                f"INLINE_OUTPUT_REJECTED: output path contains a symlink: {relative.as_posix()}"
            )


def _collect_inline_output_candidates(
    run_dir: Path,
    output_paths: Sequence[Path],
) -> List[tuple[Path, Path]]:
    """Return (absolute source, workspace-relative destination) for publishable files."""
    candidates: List[tuple[Path, Path]] = []
    seen: set[str] = set()
    for output_rel in output_paths:
        _assert_no_symlink_components(run_dir, output_rel)
        target = run_dir / output_rel
        if not target.exists():
            continue
        target_stat = os.lstat(target)
        if stat.S_ISREG(target_stat.st_mode):
            discovered = [(target, output_rel)]
        elif stat.S_ISDIR(target_stat.st_mode):
            discovered = []
            for child in sorted(target.rglob("*")):
                relative = output_rel / child.relative_to(target)
                _assert_no_symlink_components(run_dir, relative)
                child_stat = os.lstat(child)
                if stat.S_ISDIR(child_stat.st_mode):
                    continue
                if not stat.S_ISREG(child_stat.st_mode):
                    raise SandboxExecutionError(
                        "INLINE_OUTPUT_REJECTED: only regular files may be published, found a "
                        f"special file: {relative.as_posix()}"
                    )
                discovered.append((child, relative))
        else:
            raise SandboxExecutionError(
                "INLINE_OUTPUT_REJECTED: only regular files may be published, found a special "
                f"file: {output_rel.as_posix()}"
            )
        for source, relative in discovered:
            key = relative.as_posix()
            if key in seen:
                continue
            seen.add(key)
            candidates.append((source, relative))

    if len(candidates) > INLINE_MAX_OUTPUT_FILES:
        raise SandboxExecutionError(
            "INLINE_OUTPUT_LIMIT_EXCEEDED: inline run produced "
            f"{len(candidates)} output files; the limit is {INLINE_MAX_OUTPUT_FILES}."
        )
    total = 0
    for source, relative in candidates:
        size = os.lstat(source).st_size
        if size > INLINE_MAX_OUTPUT_BYTES:
            raise SandboxExecutionError(
                "INLINE_OUTPUT_TOO_LARGE: "
                f"{relative.as_posix()} is {size} bytes; the per-output limit is "
                f"{INLINE_MAX_OUTPUT_BYTES} bytes."
            )
        total += size
    if total > INLINE_MAX_TOTAL_OUTPUT_BYTES:
        raise SandboxExecutionError(
            "INLINE_TOTAL_OUTPUT_TOO_LARGE: inline outputs total "
            f"{total} bytes; the limit is {INLINE_MAX_TOTAL_OUTPUT_BYTES} bytes."
        )
    return candidates


def _publish_inline_outputs(
    workspace_state: WorkspaceState,
    run_dir: Path,
    output_paths: Sequence[Path],
) -> List[SandboxOutputFile]:
    candidates = _collect_inline_output_candidates(run_dir, output_paths)
    workspace_root = workspace_state.root_path.resolve()
    resolved: List[tuple[Path, Path, Path]] = []
    for source, relative in candidates:
        if not _is_relative_safe(relative.as_posix()):
            raise SandboxExecutionError(
                f"INLINE_OUTPUT_REJECTED: unsafe output path: {relative.as_posix()}"
            )
        destination = (workspace_root / relative).resolve()
        if destination != workspace_root and workspace_root not in destination.parents:
            raise SandboxExecutionError(
                f"INLINE_OUTPUT_REJECTED: output path escapes the workspace: {relative.as_posix()}"
            )
        if destination.is_symlink():
            raise SandboxExecutionError(
                f"INLINE_OUTPUT_REJECTED: destination is a symlink: {relative.as_posix()}"
            )
        resolved.append((source, relative, destination))

    published: List[SandboxOutputFile] = []
    for source, relative, destination in resolved:
        destination.parent.mkdir(parents=True, exist_ok=True)
        staging = destination.parent / f".{destination.name}.{uuid4().hex}.partial"
        try:
            shutil.copy2(source, staging)
            staging.chmod(0o644)
            os.replace(staging, destination)
        finally:
            if staging.exists():
                try:
                    staging.unlink()
                except OSError:
                    logger.debug("Failed removing inline staging file %s", staging, exc_info=True)
        published.append(
            SandboxOutputFile(path=f"/{relative.as_posix()}", size=destination.stat().st_size)
        )
    return published


def _remove_inline_run_dir(run_dir: Path) -> None:
    try:
        shutil.rmtree(run_dir, ignore_errors=True)
    except Exception:  # pragma: no cover - defensive cleanup guard
        logger.debug("Failed removing inline run directory %s", run_dir, exc_info=True)


def cleanup_stale_inline_run_dirs(
    workspace_state: WorkspaceState,
    *,
    keep_run_id: str | None = None,
    max_age_seconds: int = INLINE_STALE_RUN_DIR_AGE_SECONDS,
) -> List[str]:
    """Opportunistically remove inline run directories left behind by failures."""
    removed: List[str] = []
    runs_root = workspace_state.root_path / "sandbox-runs"
    try:
        if not runs_root.is_dir():
            return removed
        now = time.time()
        for child in sorted(runs_root.iterdir()):
            if child.is_symlink() or not child.is_dir():
                continue
            if not child.name.startswith(INLINE_RUN_ID_PREFIX):
                continue
            if keep_run_id and child.name == keep_run_id:
                continue
            if not (child / INLINE_RUN_MARKER_NAME).is_file():
                continue
            try:
                age = now - child.stat().st_mtime
            except OSError:
                continue
            if age < max_age_seconds:
                continue
            _remove_inline_run_dir(child)
            removed.append(child.name)
    except Exception:  # pragma: no cover - cleanup must never break a run
        logger.debug("Stale inline run cleanup failed", exc_info=True)
    return removed


def cleanup_stale_inline_run_dirs_under_root(
    workspace_root: Path | None,
    *,
    max_age_seconds: int = INLINE_STALE_RUN_DIR_AGE_SECONDS,
) -> List[str]:
    """Startup helper: sweep stale inline run directories across all workspaces."""
    removed: List[str] = []
    if workspace_root is None:
        return removed
    try:
        root = Path(workspace_root)
        if not root.is_dir():
            return removed
        for workspace_dir in sorted(root.iterdir()):
            if workspace_dir.is_symlink() or not workspace_dir.is_dir():
                continue
            runs_root = workspace_dir / "sandbox-runs"
            if not runs_root.is_dir():
                continue
            now = time.time()
            for child in sorted(runs_root.iterdir()):
                if child.is_symlink() or not child.is_dir():
                    continue
                if not child.name.startswith(INLINE_RUN_ID_PREFIX):
                    continue
                if not (child / INLINE_RUN_MARKER_NAME).is_file():
                    continue
                try:
                    if now - child.stat().st_mtime < max_age_seconds:
                        continue
                except OSError:
                    continue
                _remove_inline_run_dir(child)
                removed.append(f"{workspace_dir.name}/{child.name}")
    except Exception:  # pragma: no cover - cleanup must never break startup
        logger.debug("Startup inline run cleanup failed", exc_info=True)
    return removed


def build_inline_sandbox_job_manifest(
    *,
    job_name: str,
    workspace_id: str,
    run_id: str,
    timeout_seconds: int,
    sandbox_config: SandboxConfig,
) -> dict[str, Any]:
    """Job manifest for inline code: no /workspace mount, no workspace root env."""
    labels = {
        "app": "helpudoc-skill-sandbox",
        "helpudoc.io/workspace-id": workspace_id,
        "helpudoc.io/sandbox-run-id": run_id,
        "helpudoc.io/sandbox-mode": "inline",
    }
    safe_workspace_id = _safe_subpath_segment(workspace_id, "workspace_id")
    safe_run_id = _safe_subpath_segment(run_id, "run_id")
    effective_timeout = max(1, int(timeout_seconds))
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": job_name,
            "namespace": sandbox_config.namespace,
            "labels": labels,
        },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": effective_timeout + 30,
            "ttlSecondsAfterFinished": 300,
            "template": {
                "metadata": {"labels": labels},
                "spec": {
                    "restartPolicy": "Never",
                    "runtimeClassName": sandbox_config.runtime_class_name,
                    "automountServiceAccountToken": False,
                    "securityContext": {
                        "runAsNonRoot": True,
                        "runAsUser": 1000,
                        "runAsGroup": 1000,
                        "fsGroup": 1000,
                        "seccompProfile": {"type": "RuntimeDefault"},
                    },
                    "containers": [
                        {
                            "name": "runner",
                            "image": sandbox_config.image,
                            "imagePullPolicy": "IfNotPresent",
                            "workingDir": "/sandbox",
                            "command": ["python", f"/sandbox/scripts/{INLINE_ENTRYPOINT_NAME}"],
                            "args": [],
                            "env": [
                                {"name": "PYTHONDONTWRITEBYTECODE", "value": "1"},
                                {"name": "TMPDIR", "value": "/sandbox/tmp"},
                                {"name": "HOME", "value": "/sandbox/tmp"},
                                {"name": "PYTHONPATH", "value": "/sandbox/scripts:/sandbox"},
                                {"name": "HELPUDOC_SANDBOX_RUN_DIR", "value": "/sandbox"},
                                {"name": "HELPUDOC_SANDBOX_MODE", "value": "inline"},
                            ],
                            "resources": {
                                "limits": {
                                    "cpu": sandbox_config.cpu_limit,
                                    "memory": sandbox_config.memory_limit,
                                    "ephemeral-storage": sandbox_config.ephemeral_storage_limit,
                                },
                                "requests": {
                                    "cpu": "100m",
                                    "memory": "128Mi",
                                    "ephemeral-storage": "128Mi",
                                },
                            },
                            "securityContext": {
                                "allowPrivilegeEscalation": False,
                                "readOnlyRootFilesystem": True,
                                "capabilities": {"drop": ["ALL"]},
                            },
                            "volumeMounts": [
                                {
                                    "name": "sandbox-workspace",
                                    "mountPath": "/sandbox",
                                    "subPath": f"{safe_workspace_id}/sandbox-runs/{safe_run_id}",
                                }
                            ],
                        }
                    ],
                    "volumes": [
                        {
                            "name": "sandbox-workspace",
                            "persistentVolumeClaim": {"claimName": sandbox_config.workspace_pvc},
                        }
                    ],
                },
            },
        },
    }


def run_inline_python_in_kubernetes(
    *,
    skills_root: Path | None,
    workspace_state: WorkspaceState,
    inline_code: str,
    input_paths: Iterable[str] | None = None,
    output_paths: Iterable[str] | None = None,
    timeout_seconds: int | None = None,
    batch_api: Any | None = None,
    core_api: Any | None = None,
    sandbox_config: SandboxConfig | None = None,
) -> SandboxRunResult:
    if not inline_sandbox_enabled():
        raise InlineSandboxDisabledError(
            "SANDBOX_INLINE_DISABLED: inline Python execution is turned off. Use a declared "
            "sandbox script from the active skill."
        )
    # An active skill is required in both modes.
    _resolve_skill(skills_root=skills_root, workspace_state=workspace_state)
    normalized_inputs = _normalize_inline_inputs(input_paths)
    normalized_outputs = _normalize_inline_outputs(output_paths)
    effective_timeout = _resolve_inline_timeout(timeout_seconds)
    global_ceiling = inline_global_job_ceiling()

    sandbox_config = sandbox_config or SandboxConfig.from_env()
    if batch_api is None or core_api is None:
        batch_api, core_api = _load_kubernetes_clients()

    cleanup_stale_inline_run_dirs(workspace_state)
    run_id, run_dir, source_sha256 = _stage_inline_run(
        workspace_state=workspace_state,
        inline_code=inline_code,
        input_paths=normalized_inputs,
        output_paths=normalized_outputs,
    )
    _reserve_inline_execution(workspace_state)
    job_name = f"helpudoc-sandbox-{run_id[:24]}"
    logger.info(
        "Inline sandbox run %s starting: job=%s source_sha256=%s inputs=%d outputs=%d timeout=%ds",
        run_id,
        job_name,
        source_sha256,
        len(normalized_inputs),
        len(normalized_outputs),
        effective_timeout,
    )
    manifest = build_inline_sandbox_job_manifest(
        job_name=job_name,
        workspace_id=workspace_state.workspace_id,
        run_id=run_id,
        timeout_seconds=effective_timeout,
        sandbox_config=sandbox_config,
    )
    try:
        with _inline_job_slot(workspace_state.workspace_id, global_ceiling=global_ceiling):
            try:
                batch_api.create_namespaced_job(namespace=sandbox_config.namespace, body=manifest)
                stdout, stderr = _wait_for_job(
                    batch_api,
                    core_api,
                    namespace=sandbox_config.namespace,
                    job_name=job_name,
                    timeout_seconds=effective_timeout,
                    poll_interval_seconds=sandbox_config.poll_interval_seconds,
                    max_stdout_bytes=INLINE_MAX_STDOUT_BYTES,
                    max_stderr_bytes=INLINE_MAX_STDERR_BYTES,
                )
            finally:
                try:
                    batch_api.delete_namespaced_job(
                        name=job_name,
                        namespace=sandbox_config.namespace,
                        propagation_policy="Background",
                    )
                except Exception:
                    logger.info(
                        "Inline sandbox job cleanup skipped or failed for %s", job_name, exc_info=True
                    )
        outputs = _publish_inline_outputs(workspace_state, run_dir, normalized_outputs)
    finally:
        _remove_inline_run_dir(run_dir)

    return SandboxRunResult(
        run_id=run_id,
        job_name=job_name,
        stdout=stdout[:INLINE_MAX_STDOUT_BYTES],
        stderr=stderr[:INLINE_MAX_STDERR_BYTES],
        output_files=outputs,
        mode="inline",
        source_sha256=source_sha256,
    )


def run_inline_python(
    *,
    skills_root: Path | None,
    workspace_state: WorkspaceState,
    inline_code: str,
    input_paths: Iterable[str] | None = None,
    output_paths: Iterable[str] | None = None,
    timeout_seconds: int | None = None,
) -> SandboxRunResult:
    if not inline_sandbox_enabled():
        raise InlineSandboxDisabledError(
            "SANDBOX_INLINE_DISABLED: inline Python execution is turned off. Use a declared "
            "sandbox script from the active skill."
        )
    if _resolve_sandbox_backend() != "kubernetes":
        raise SandboxUnavailableError(
            "SANDBOX_UNAVAILABLE: inline Python execution requires the Kubernetes sandbox. The "
            "local subprocess fallback is not an isolation boundary, so inline code never runs "
            "outside a cluster."
        )
    return run_inline_python_in_kubernetes(
        skills_root=skills_root,
        workspace_state=workspace_state,
        inline_code=inline_code,
        input_paths=input_paths or [],
        output_paths=output_paths or [],
        timeout_seconds=timeout_seconds,
    )


def run_skill_python_script(
    *,
    skills_root: Path | None,
    plugins_root: Path | None = None,
    workspace_state: WorkspaceState,
    script_name: str | None = None,
    input_paths: Iterable[str] | None = None,
    args: Iterable[str] | None = None,
    inline_code: str | None = None,
    output_paths: Iterable[str] | None = None,
    timeout_seconds: int | None = None,
) -> SandboxRunResult:
    has_script = bool(str(script_name or "").strip())
    has_inline = bool(str(inline_code or "").strip())
    if has_script and has_inline:
        raise SandboxExecutionError(
            "Provide exactly one of script_name or inline_code, not both."
        )
    if not has_script and not has_inline:
        raise SandboxExecutionError("Provide exactly one of script_name or inline_code.")

    if has_inline:
        if list(args or []):
            raise SandboxExecutionError("args is only supported for declared script_name runs.")
        return run_inline_python(
            skills_root=skills_root,
            workspace_state=workspace_state,
            inline_code=str(inline_code),
            input_paths=input_paths or [],
            output_paths=output_paths or [],
            timeout_seconds=timeout_seconds,
        )

    if list(output_paths or []):
        raise SandboxExecutionError(
            "output_paths is only supported for inline_code runs; declared scripts publish their "
            "declared outputs."
        )
    if timeout_seconds is not None:
        raise SandboxExecutionError(
            "timeout_seconds is only supported for inline_code runs; declared scripts use their "
            "declared timeout."
        )

    backend = _resolve_sandbox_backend()
    if backend == "kubernetes":
        return run_skill_python_script_in_kubernetes(
            skills_root=skills_root,
            plugins_root=plugins_root,
            workspace_state=workspace_state,
            script_name=str(script_name),
            input_paths=input_paths or [],
            args=args or [],
        )
    return run_skill_python_script_locally(
        skills_root=skills_root,
        plugins_root=plugins_root,
        workspace_state=workspace_state,
        script_name=str(script_name),
        input_paths=input_paths or [],
        args=args or [],
    )
