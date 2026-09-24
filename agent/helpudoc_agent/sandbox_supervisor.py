"""Trusted wrapper for agent-authored Python inside the inline sandbox image.

The supervisor is intentionally stdlib-only.  It downloads one run-scoped input
bundle, expands it into a private writable workspace, executes the authored
Python as a child process, computes the resulting filesystem delta, and uploads
one bounded result bundle.  Canonical workspace publication remains a host-side
operation; this process never receives object-store credentials or a workspace
PVC.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from typing import Any, Iterable
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


CONTROL_DIR_NAME = ".helpudoc-control"
INPUT_MANIFEST_NAME = "input-manifest.json"
ENTRYPOINT_NAME = "inline_main.py"
RESULT_MANIFEST_NAME = ".helpudoc-result.json"
MAX_INLINE_CODE_TIMEOUT_SECONDS = 300


class SandboxSupervisorError(RuntimeError):
    """Raised when a run bundle or produced workspace violates the contract."""


def _positive_int_env(name: str, default: int) -> int:
    raw = str(os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise SandboxSupervisorError(f"{name} must be a positive integer") from exc
    if value < 1:
        raise SandboxSupervisorError(f"{name} must be a positive integer")
    return value


def _manifest_timeout_seconds(manifest: dict[str, Any]) -> int:
    raw = manifest.get("timeout_seconds")
    if isinstance(raw, bool):
        raise SandboxSupervisorError("Input manifest execution timeout is invalid")
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise SandboxSupervisorError("Input manifest execution timeout is invalid") from exc
    if value < 1 or value > MAX_INLINE_CODE_TIMEOUT_SECONDS:
        raise SandboxSupervisorError(
            "Input manifest execution timeout must be between 1 and "
            f"{MAX_INLINE_CODE_TIMEOUT_SECONDS} seconds"
        )
    return value


def _safe_relative_path(raw: str, *, label: str = "path") -> str:
    value = str(raw or "").strip().replace("\\", "/")
    path = PurePosixPath(value)
    if (
        not value
        or value.startswith("/")
        or path == PurePosixPath(".")
        or ".." in path.parts
        or not path.parts
    ):
        raise SandboxSupervisorError(f"Unsafe {label}: {raw}")
    return path.as_posix()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download_file(url: str, destination: Path, *, max_bytes: int) -> None:
    if not str(url or "").strip():
        raise SandboxSupervisorError("Input download URL is missing")
    request = Request(url, method="GET")
    total = 0
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urlopen(request, timeout=60) as response, destination.open("wb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise SandboxSupervisorError(
                    f"Input bundle exceeds the {max_bytes}-byte transfer limit"
                )
            output.write(chunk)


def _upload_file(url: str, source: Path) -> None:
    """Stream a file to a presigned HTTP(S) PUT URL with a fixed content length."""
    parsed = urlsplit(str(url or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise SandboxSupervisorError("Result upload URL must be HTTP or HTTPS")
    connection_type = (
        http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    )
    connection = connection_type(parsed.hostname, parsed.port, timeout=60)
    request_path = parsed.path or "/"
    if parsed.query:
        request_path = f"{request_path}?{parsed.query}"
    size = source.stat().st_size
    try:
        connection.putrequest("PUT", request_path)
        connection.putheader("Content-Length", str(size))
        connection.endheaders()
        with source.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                connection.send(chunk)
        response = connection.getresponse()
        response_body = response.read(4096)
        if response.status < 200 or response.status >= 300:
            detail = response_body.decode("utf-8", errors="replace").strip()
            raise SandboxSupervisorError(
                f"Result upload failed with HTTP {response.status}: {detail[:500]}"
            )
    finally:
        connection.close()


def safe_extract_input_bundle(
    archive_path: Path,
    workspace_root: Path,
    *,
    max_files: int,
    max_total_bytes: int,
    max_file_bytes: int,
) -> None:
    """Extract a host-created archive without accepting links or special files."""
    workspace_root.mkdir(parents=True, exist_ok=True)
    root = workspace_root.resolve()
    file_count = 0
    total_bytes = 0
    with tarfile.open(archive_path, mode="r:*") as archive:
        for member in archive:
            relative = _safe_relative_path(member.name, label="archive member")
            destination = (root / relative).resolve()
            if destination != root and root not in destination.parents:
                raise SandboxSupervisorError(f"Archive member escapes workspace: {relative}")
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                raise SandboxSupervisorError(
                    f"Input archive contains a link or special file: {relative}"
                )
            file_count += 1
            total_bytes += int(member.size)
            if file_count > max_files:
                raise SandboxSupervisorError(
                    f"Input archive exceeds the {max_files}-file limit"
                )
            if int(member.size) > max_file_bytes:
                raise SandboxSupervisorError(
                    f"Input file exceeds the {max_file_bytes}-byte limit: {relative}"
                )
            if total_bytes > max_total_bytes:
                raise SandboxSupervisorError(
                    f"Input archive exceeds the {max_total_bytes}-byte expanded limit"
                )
            extracted = archive.extractfile(member)
            if extracted is None:
                raise SandboxSupervisorError(f"Unable to read archive member: {relative}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            with extracted, destination.open("wb") as output:
                shutil.copyfileobj(extracted, output, length=1024 * 1024)
            destination.chmod(0o600 if relative.startswith(f"{CONTROL_DIR_NAME}/") else 0o644)


def _iter_workspace_files(workspace_root: Path) -> Iterable[tuple[str, Path]]:
    root = workspace_root.resolve()
    stack = [root]
    while stack:
        current = stack.pop()
        for entry in sorted(os.scandir(current), key=lambda item: item.name):
            relative = Path(entry.path).relative_to(root).as_posix()
            if relative == CONTROL_DIR_NAME or relative.startswith(f"{CONTROL_DIR_NAME}/"):
                continue
            entry_stat = entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(entry_stat.st_mode):
                raise SandboxSupervisorError(f"Workspace contains a symlink: {relative}")
            if stat.S_ISDIR(entry_stat.st_mode):
                stack.append(Path(entry.path))
                continue
            if not stat.S_ISREG(entry_stat.st_mode):
                raise SandboxSupervisorError(
                    f"Workspace contains a special file: {relative}"
                )
            yield relative, Path(entry.path)


def _path_is_selected(path: str, output_paths: list[str]) -> bool:
    if not output_paths:
        return True
    candidate = PurePosixPath(path)
    for raw in output_paths:
        selected = PurePosixPath(raw)
        if candidate == selected or selected in candidate.parents:
            return True
    return False


def compute_workspace_delta(
    workspace_root: Path,
    baseline: dict[str, dict[str, Any]],
    *,
    output_paths: list[str] | None,
    max_files: int,
    max_total_bytes: int,
    max_file_bytes: int,
) -> tuple[list[dict[str, Any]], list[str]]:
    selected = [
        _safe_relative_path(item, label="output path") for item in (output_paths or [])
    ]
    current: dict[str, dict[str, Any]] = {}
    total_bytes = 0
    for relative, source in _iter_workspace_files(workspace_root):
        size = source.stat().st_size
        if size > max_file_bytes:
            raise SandboxSupervisorError(
                f"Produced file exceeds the {max_file_bytes}-byte limit: {relative}"
            )
        current[relative] = {
            "path": source,
            "size": size,
            "sha256": _sha256_file(source),
        }

    changed: list[dict[str, Any]] = []
    for relative in sorted(current):
        if not _path_is_selected(relative, selected):
            continue
        before = baseline.get(relative)
        item = current[relative]
        if before and str(before.get("sha256") or "") == item["sha256"]:
            continue
        total_bytes += int(item["size"])
        changed.append(
            {
                "path": relative,
                "size": int(item["size"]),
                "sha256": item["sha256"],
                "kind": "update" if before else "create",
                "source": item["path"],
            }
        )

    deleted = sorted(
        relative
        for relative in baseline
        if relative not in current and _path_is_selected(relative, selected)
    )
    if len(changed) + len(deleted) > max_files:
        raise SandboxSupervisorError(
            f"Workspace delta exceeds the {max_files}-operation limit"
        )
    if total_bytes > max_total_bytes:
        raise SandboxSupervisorError(
            f"Workspace delta exceeds the {max_total_bytes}-byte limit"
        )
    return changed, deleted


def create_result_bundle(
    destination: Path,
    *,
    run_id: str,
    source_sha256: str,
    changed: list[dict[str, Any]],
    deleted: list[str],
) -> dict[str, Any]:
    manifest = {
        "version": 1,
        "run_id": run_id,
        "source_sha256": source_sha256,
        "files": [
            {
                "path": item["path"],
                "size": item["size"],
                "sha256": item["sha256"],
                "kind": item["kind"],
            }
            for item in changed
        ],
        "deleted": list(deleted),
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
    with tarfile.open(destination, mode="w") as archive:
        manifest_info = tarfile.TarInfo(RESULT_MANIFEST_NAME)
        manifest_info.size = len(encoded)
        manifest_info.mode = 0o600
        manifest_info.mtime = 0
        import io

        archive.addfile(manifest_info, io.BytesIO(encoded))
        for item in changed:
            info = archive.gettarinfo(
                str(item["source"]),
                arcname=f"files/{item['path']}",
            )
            info.uid = 1000
            info.gid = 1000
            info.uname = "sandbox"
            info.gname = "sandbox"
            info.mode = 0o600
            info.mtime = 0
            with Path(item["source"]).open("rb") as handle:
                archive.addfile(info, handle)
    return manifest


def _child_environment(workspace_root: Path) -> dict[str, str]:
    # Transfer URLs stay in the supervisor environment.  This is defense in
    # depth; the cryptographic boundary is still the run-scoped signed URL.
    allowed = {
        "PATH": os.getenv("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "LANG": os.getenv("LANG", "C.UTF-8"),
        "LC_ALL": os.getenv("LC_ALL", "C.UTF-8"),
        "HOME": "/workspace/.tmp",
        "TMPDIR": "/workspace/.tmp",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "HELPUDOC_WORKSPACE_ROOT": str(workspace_root),
        "HELPUDOC_SANDBOX_MODE": "inline",
    }
    return allowed


def supervise() -> int:
    workspace_root = Path(os.getenv("HELPUDOC_WORKSPACE_ROOT") or "/workspace").resolve()
    workspace_root.mkdir(parents=True, exist_ok=True)
    transfer_limit = _positive_int_env("HELPUDOC_SANDBOX_MAX_TRANSFER_BYTES", 300 * 1024 * 1024)
    max_input_files = _positive_int_env("HELPUDOC_SANDBOX_MAX_INPUT_FILES", 512)
    max_input_bytes = _positive_int_env("HELPUDOC_SANDBOX_MAX_INPUT_BYTES", 256 * 1024 * 1024)
    max_output_files = _positive_int_env("HELPUDOC_SANDBOX_MAX_OUTPUT_FILES", 64)
    max_output_bytes = _positive_int_env("HELPUDOC_SANDBOX_MAX_OUTPUT_BYTES", 256 * 1024 * 1024)
    max_file_bytes = _positive_int_env("HELPUDOC_SANDBOX_MAX_FILE_BYTES", 100 * 1024 * 1024)

    with tempfile.TemporaryDirectory(prefix="helpudoc-supervisor-", dir="/tmp") as temporary:
        temporary_root = Path(temporary)
        input_bundle = temporary_root / "input.tar"
        result_bundle = temporary_root / "result.tar"
        _download_file(
            os.getenv("HELPUDOC_SANDBOX_INPUT_URL") or "",
            input_bundle,
            max_bytes=transfer_limit,
        )
        safe_extract_input_bundle(
            input_bundle,
            workspace_root,
            max_files=max_input_files + 2,
            max_total_bytes=max_input_bytes + 1024 * 1024,
            max_file_bytes=max_file_bytes,
        )

        control_root = workspace_root / CONTROL_DIR_NAME
        manifest_path = control_root / INPUT_MANIFEST_NAME
        entrypoint = control_root / ENTRYPOINT_NAME
        if not manifest_path.is_file() or not entrypoint.is_file():
            raise SandboxSupervisorError("Input bundle is missing trusted control files")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or int(manifest.get("version") or 0) != 1:
            raise SandboxSupervisorError("Unsupported input manifest")
        run_id = str(manifest.get("run_id") or "").strip()
        source_sha256 = str(manifest.get("source_sha256") or "").strip().lower()
        if not run_id or len(source_sha256) != 64 or _sha256_file(entrypoint) != source_sha256:
            raise SandboxSupervisorError("Inline entrypoint integrity check failed")
        raw_baseline = manifest.get("baseline")
        if not isinstance(raw_baseline, dict):
            raise SandboxSupervisorError("Input manifest baseline is invalid")
        baseline = {
            _safe_relative_path(path, label="baseline path"): value
            for path, value in raw_baseline.items()
            if isinstance(value, dict)
        }
        raw_outputs = manifest.get("output_paths")
        output_paths = raw_outputs if isinstance(raw_outputs, list) else []
        code_timeout_seconds = _manifest_timeout_seconds(manifest)

        (workspace_root / ".tmp").mkdir(parents=True, exist_ok=True)
        try:
            completed = subprocess.run(
                [sys.executable, str(entrypoint)],
                cwd=str(workspace_root),
                env=_child_environment(workspace_root),
                check=False,
                timeout=code_timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise SandboxSupervisorError(
                f"Inline Python exceeded its {code_timeout_seconds}-second execution timeout"
            ) from exc
        if completed.returncode != 0:
            raise SandboxSupervisorError(
                f"Inline Python exited with status {completed.returncode}"
            )

        changed, deleted = compute_workspace_delta(
            workspace_root,
            baseline,
            output_paths=[str(item) for item in output_paths],
            max_files=max_output_files,
            max_total_bytes=max_output_bytes,
            max_file_bytes=max_file_bytes,
        )
        result_manifest = create_result_bundle(
            result_bundle,
            run_id=run_id,
            source_sha256=source_sha256,
            changed=changed,
            deleted=deleted,
        )
        if result_bundle.stat().st_size > transfer_limit:
            raise SandboxSupervisorError(
                f"Result bundle exceeds the {transfer_limit}-byte transfer limit"
            )
        _upload_file(os.getenv("HELPUDOC_SANDBOX_RESULT_URL") or "", result_bundle)
        print(
            json.dumps(
                {
                    "status": "ok",
                    "run_id": run_id,
                    "changed": len(result_manifest["files"]),
                    "deleted": len(result_manifest["deleted"]),
                },
                separators=(",", ":"),
            )
        )
    return 0


def main() -> int:
    try:
        return supervise()
    except Exception as exc:
        print(f"SANDBOX_SUPERVISOR_ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
