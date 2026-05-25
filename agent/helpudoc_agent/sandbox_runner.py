"""Kubernetes-backed execution for declared skill scripts."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import logging
import os
from pathlib import Path
import shutil
import time
from typing import Any, Iterable, List
from uuid import uuid4

from .config.env import load_sandbox_k8s_env
from .skills_registry import SkillMetadata, SkillSandboxScript, find_skill
from .state import WorkspaceState

logger = logging.getLogger(__name__)


class SandboxExecutionError(RuntimeError):
    """Raised when a sandbox run is invalid or fails."""


class SandboxUnavailableError(SandboxExecutionError):
    """Raised when Kubernetes execution is not configured for this process."""


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


def _resolve_script(skill: SkillMetadata, script_name: str) -> SkillSandboxScript:
    normalized = str(script_name or "").strip()
    if not normalized:
        raise SandboxExecutionError("script_name is required.")
    for script in skill.sandbox_scripts:
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
    skill = find_skill(skills_root, active_skill_id)
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
    skill_dir = skill.path.parent.resolve()
    script_rel = str(script.path or "").strip().replace("\\", "/")
    if not _is_relative_safe(script_rel):
        raise SandboxExecutionError(f"Script path for '{script.name}' must be relative to the skill directory.")
    script_path = (skill_dir / script_rel).resolve()
    if script_path != skill_dir and skill_dir not in script_path.parents:
        raise SandboxExecutionError(f"Script path for '{script.name}' escapes the skill directory.")
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
    _chmod_best_effort(run_dir, 0o777)
    _chmod_best_effort(scripts_dir, 0o755)
    _chmod_best_effort(run_dir / "tmp", 0o777)

    skill_scripts_dir = skill_dir / "scripts"
    if skill_scripts_dir.is_dir() and (
        script_path == skill_scripts_dir or skill_scripts_dir in script_path.parents
    ):
        shutil.rmtree(scripts_dir)
        shutil.copytree(skill_scripts_dir, scripts_dir, ignore=_ignore_script_cache_dirs)
        staged_script = run_dir / script_path.relative_to(skill_dir)
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


def _collect_logs(core_api: Any, *, namespace: str, job_name: str) -> tuple[str, str]:
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
    return "\n".join(part for part in stdout_parts if part).strip(), ""


def _wait_for_job(
    batch_api: Any,
    core_api: Any,
    *,
    namespace: str,
    job_name: str,
    timeout_seconds: int,
    poll_interval_seconds: float,
) -> tuple[str, str]:
    deadline = time.monotonic() + timeout_seconds + 45
    while time.monotonic() < deadline:
        status = batch_api.read_namespaced_job_status(name=job_name, namespace=namespace).status
        if int(getattr(status, "succeeded", 0) or 0) > 0:
            return _collect_logs(core_api, namespace=namespace, job_name=job_name)
        if int(getattr(status, "failed", 0) or 0) > 0:
            stdout, stderr = _collect_logs(core_api, namespace=namespace, job_name=job_name)
            raise SandboxExecutionError(
                f"Sandbox job '{job_name}' failed.\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}".strip()
            )
        time.sleep(poll_interval_seconds)
    stdout, stderr = _collect_logs(core_api, namespace=namespace, job_name=job_name)
    raise SandboxExecutionError(
        f"Sandbox job '{job_name}' timed out.\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}".strip()
    )


def run_skill_python_script_in_kubernetes(
    *,
    skills_root: Path | None,
    workspace_state: WorkspaceState,
    script_name: str,
    input_paths: Iterable[str] | None = None,
    args: Iterable[str] | None = None,
    batch_api: Any | None = None,
    core_api: Any | None = None,
    sandbox_config: SandboxConfig | None = None,
) -> SandboxRunResult:
    skill = _resolve_skill(skills_root=skills_root, workspace_state=workspace_state)
    script = _resolve_script(skill, script_name)
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

    outputs: List[SandboxOutputFile] = []
    for raw_output in script.outputs:
        output_rel = _safe_declared_output(raw_output)
        output_path = run_dir / output_rel
        if output_path.is_file():
            outputs.append(
                SandboxOutputFile(
                    path=f"/sandbox-runs/{run_id}/{output_rel.as_posix()}",
                    size=output_path.stat().st_size,
                )
            )
    return SandboxRunResult(
        run_id=run_id,
        job_name=job_name,
        stdout=stdout,
        stderr=stderr,
        output_files=outputs,
    )
