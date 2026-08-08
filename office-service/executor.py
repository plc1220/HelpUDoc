"""OfficeCLI batch executor — subprocess management and atomic publish."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any

from config import ServiceConfig
from models import BatchSummary, ExecuteResponse, OperationResult, ValidationResult

_cached_version: str | None = None
_cached_sha256: str | None = None
_output_locks: dict[str, asyncio.Lock] = {}
_output_lock_refs: dict[str, int] = {}
_locks_meta_lock = asyncio.Lock()

# OfficeCLI reserves rc=2 for successful *batch* commands with advisory
# warnings. Create and validate use the ordinary 0/1 contract.
_BATCH_SUCCESS_RETURNCODES = frozenset({0, 2})
_STANDARD_SUCCESS_RETURNCODES = frozenset({0})


class OfficeCLIOutputError(Exception):
    """Raised when OfficeCLI output cannot be safely interpreted (502/no publish)."""


async def _acquire_output_lock(output_path: str) -> asyncio.Lock:
    async with _locks_meta_lock:
        if output_path not in _output_locks:
            _output_locks[output_path] = asyncio.Lock()
            _output_lock_refs[output_path] = 0
        _output_lock_refs[output_path] += 1
        return _output_locks[output_path]


async def _release_output_lock(output_path: str) -> None:
    async with _locks_meta_lock:
        _output_lock_refs[output_path] -= 1
        if _output_lock_refs[output_path] <= 0:
            _output_locks.pop(output_path, None)
            _output_lock_refs.pop(output_path, None)


def get_binary_sha256(config: ServiceConfig) -> str:
    global _cached_sha256
    if _cached_sha256 is not None:
        return _cached_sha256
    h = hashlib.sha256()
    try:
        with open(config.officecli_bin, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
        _cached_sha256 = h.hexdigest()
    except FileNotFoundError:
        _cached_sha256 = "binary-not-found"
    return _cached_sha256


def get_officecli_version(config: ServiceConfig) -> str:
    global _cached_version
    if _cached_version is not None:
        return _cached_version
    try:
        import subprocess
        result = subprocess.run(
            [config.officecli_bin, "--version"],
            capture_output=True, text=True, timeout=10,
            env=_build_env(config),
        )
        _cached_version = result.stdout.strip() or "unavailable"
    except (FileNotFoundError, subprocess.TimeoutExpired):
        _cached_version = "unavailable"
    return _cached_version


def reset_caches() -> None:
    global _cached_version, _cached_sha256
    _cached_version = None
    _cached_sha256 = None


def is_binary_ready(config: ServiceConfig) -> bool:
    import subprocess
    try:
        result = subprocess.run(
            [config.officecli_bin, "--version"],
            capture_output=True, text=True, timeout=10,
            env=_build_env(config),
        )
        return result.returncode == 0 and bool(result.stdout.strip())
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False


def _build_env(config: ServiceConfig) -> dict[str, str]:
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": "/tmp/officecli-home",
        "OFFICECLI_SKIP_UPDATE": "1",
        "OFFICECLI_NO_AUTO_RESIDENT": "1",
        "LANG": "C.UTF-8",
        # Keep OfficeCLI spill files in the same trusted directory validated
        # by this process, including during local development on macOS.
        "TMPDIR": tempfile.gettempdir(),
    }


# ---------------------------------------------------------------------------
# Subprocess: readers + proc.wait under single deadline, kill/reap on any exit
# ---------------------------------------------------------------------------


def _kill_process_group(proc: asyncio.subprocess.Process) -> None:
    import signal
    pid = proc.pid
    if pid is None:
        return
    try:
        # start_new_session=True makes the original child PID the process-group
        # ID. Keep using it even if the direct child has already exited: a
        # background descendant may still own the pipes and keep the group alive.
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass


async def _run_subprocess(
    config: ServiceConfig, argv: list[str]
) -> tuple[str, str, int]:
    """Run OfficeCLI subprocess with bounded output and overall deadline.

    The deadline covers readers AND proc.wait (child may close pipes but
    keep running). On timeout or cancellation, kills process group and reaps.
    """
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=_build_env(config),
        start_new_session=True,
    )

    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []
    stdout_len = 0
    stderr_len = 0
    cap_error: str | None = None

    async def drain_stdout():
        nonlocal stdout_len, cap_error
        assert proc.stdout is not None
        while True:
            chunk = await proc.stdout.read(8192)
            if not chunk:
                break
            stdout_len += len(chunk)
            if stdout_len > config.max_stdout_bytes:
                cap_error = f"stdout exceeded {config.max_stdout_bytes} bytes"
                _kill_process_group(proc)
                return
            stdout_chunks.append(chunk)

    async def drain_stderr():
        nonlocal stderr_len, cap_error
        assert proc.stderr is not None
        while True:
            chunk = await proc.stderr.read(8192)
            if not chunk:
                break
            stderr_len += len(chunk)
            if stderr_len > config.max_stderr_bytes:
                cap_error = f"stderr exceeded {config.max_stderr_bytes} bytes"
                _kill_process_group(proc)
                return
            stderr_chunks.append(chunk)

    async def _drain_and_wait():
        """Drain both streams, then wait for process exit — all under one deadline."""
        stdout_task = asyncio.create_task(drain_stdout())
        stderr_task = asyncio.create_task(drain_stderr())
        try:
            await asyncio.gather(stdout_task, stderr_task)
            await proc.wait()
        finally:
            for task in (stdout_task, stderr_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)

    try:
        await asyncio.wait_for(_drain_and_wait(), timeout=config.timeout_seconds)
    except asyncio.TimeoutError:
        _kill_process_group(proc)
        await proc.wait()
        raise
    except asyncio.CancelledError:
        _kill_process_group(proc)
        await asyncio.shield(proc.wait())
        raise
    except Exception:
        _kill_process_group(proc)
        await proc.wait()
        raise

    if cap_error:
        raise OfficeCLIOutputError(f"OfficeCLI {cap_error}")

    stdout_text = b"".join(stdout_chunks).decode("utf-8", errors="replace")
    stderr_text = b"".join(stderr_chunks).decode("utf-8", errors="replace")
    return stdout_text, stderr_text, proc.returncode


# ---------------------------------------------------------------------------
# Strict JSON parsing
# ---------------------------------------------------------------------------


def _parse_json_strict(stdout: str) -> dict[str, Any]:
    stdout = stdout.strip()
    if not stdout:
        raise OfficeCLIOutputError("OfficeCLI produced empty stdout")
    try:
        parsed = json.loads(stdout)
    except json.JSONDecodeError as e:
        raise OfficeCLIOutputError(f"Malformed JSON: {e}") from e
    if not isinstance(parsed, dict):
        raise OfficeCLIOutputError(f"Envelope must be object, got {type(parsed).__name__}")
    if "success" not in parsed:
        raise OfficeCLIOutputError("Envelope missing 'success' field")
    if not isinstance(parsed["success"], bool):
        raise OfficeCLIOutputError(f"'success' must be bool, got {type(parsed['success']).__name__}")
    return parsed


def _strict_int(val: Any, name: str) -> int:
    """Require val to be int (not bool)."""
    if isinstance(val, bool) or not isinstance(val, int):
        raise OfficeCLIOutputError(f"'{name}' must be int, got {type(val).__name__}")
    return val


def _assert_workspace_containment(workspace_base: Path, path: Path, label: str) -> None:
    """Recheck containment immediately before filesystem use.

    The API performs the primary validation. This second check, made under the
    per-output lock, rejects directory/symlink swaps that occurred while the
    request was queued. The shared workspace volume is otherwise a trusted
    sibling-container boundary (documented in README.md).
    """
    try:
        base = workspace_base.resolve(strict=True)
        target = path.resolve(strict=False)
    except OSError as e:
        raise OfficeCLIOutputError(f"Cannot resolve {label}: {e}") from e
    if target == base or base not in target.parents:
        raise OfficeCLIOutputError(f"{label} escaped the workspace during execution")


# ---------------------------------------------------------------------------
# Batch output parsing — strict contract validation
# ---------------------------------------------------------------------------


def _parse_batch_output(
    stdout: str, stderr: str, returncode: int, operations: list[dict[str, Any]],
    max_stdout_bytes: int = 10 * 1024 * 1024,
) -> tuple[bool, bool, list[OperationResult], BatchSummary | None, list[str]]:
    """Parse batch output strictly. Returns (success, contract_valid, results, summary, warnings)."""
    warnings: list[str] = []
    if stderr.strip():
        warnings.extend(stderr.strip().splitlines()[:20])
    num_ops = len(operations)

    # Parse envelope
    try:
        parsed = _parse_json_strict(stdout)
    except OfficeCLIOutputError as e:
        results = _synthetic_failures(operations, str(e))
        return False, False, results, None, warnings + [str(e)]

    envelope_success = parsed["success"]

    raw_warnings = parsed.get("warnings", [])
    if not isinstance(raw_warnings, list):
        results = _synthetic_failures(operations, "envelope warnings must be an array")
        return False, False, results, None, warnings + ["warnings not array"]
    for i, warning in enumerate(raw_warnings):
        if not isinstance(warning, dict) or not isinstance(warning.get("message"), str):
            results = _synthetic_failures(
                operations, f"warning[{i}] must be an object with string message"
            )
            return False, False, results, None, warnings + ["invalid warning object"]
        for optional_key in ("code", "suggestion", "kind", "key", "value"):
            optional_value = warning.get(optional_key)
            if optional_value is not None and not isinstance(optional_value, str):
                results = _synthetic_failures(
                    operations, f"warning[{i}].{optional_key} must be a string"
                )
                return False, False, results, None, warnings + ["invalid warning object"]
        available = warning.get("available")
        if available is not None and (
            not isinstance(available, list)
            or any(not isinstance(value, str) for value in available)
        ):
            results = _synthetic_failures(
                operations, f"warning[{i}].available must be a string array"
            )
            return False, False, results, None, warnings + ["invalid warning object"]
        code = warning.get("code")
        warnings.append(f"[{code}] {warning['message']}" if code else warning["message"])

    data = parsed.get("data")
    if not isinstance(data, dict):
        results = _synthetic_failures(operations, "data is not an object")
        return False, False, results, None, warnings + ["data not dict"]

    # Spill file handling
    if "outputFile" in data:
        output_file = data["outputFile"]
        if not isinstance(output_file, str):
            results = _synthetic_failures(operations, "outputFile must be string")
            return False, False, results, None, warnings + ["outputFile wrong type"]
        data = _read_spill_file(output_file, data, max_size=max_stdout_bytes)

    # Results array
    raw_results = data.get("results")
    if not isinstance(raw_results, list):
        results = _synthetic_failures(operations, "data.results not array")
        return False, False, results, None, warnings + ["results not array"]

    if len(raw_results) != num_ops:
        results = _synthetic_failures(
            operations, f"result count {len(raw_results)} != operation count {num_ops}"
        )
        return False, False, results, None, warnings + ["result count mismatch"]

    # Strict per-item validation
    results: list[OperationResult] = []
    succeeded_count = 0
    failed_count = 0
    try:
        for i, item in enumerate(raw_results):
            cmd = operations[i].get("command") or operations[i].get("op", "unknown")
            if not isinstance(item, dict):
                raise OfficeCLIOutputError(f"result[{i}] not an object")

            idx = item.get("index")
            idx = _strict_int(idx, f"result[{i}].index")
            if idx != i:
                raise OfficeCLIOutputError(f"result[{i}].index={idx}, expected {i}")

            item_success = item.get("success")
            if not isinstance(item_success, bool):
                raise OfficeCLIOutputError(f"result[{i}].success not bool")

            # Optional fields type check
            error_val = item.get("error")
            if error_val is not None and not isinstance(error_val, str):
                raise OfficeCLIOutputError(f"result[{i}].error not string")
            code_val = item.get("code")
            if code_val is not None and not isinstance(code_val, str):
                raise OfficeCLIOutputError(f"result[{i}].code not string")

            if item_success:
                succeeded_count += 1
            else:
                failed_count += 1

            results.append(OperationResult(
                index=idx, success=item_success, command=cmd,
                output=item.get("output"), error=error_val, code=code_val,
            ))
    except OfficeCLIOutputError as e:
        return False, False, _synthetic_failures(operations, str(e)), None, warnings + [str(e)]

    # Summary strict validation
    raw_summary = data.get("summary")
    if not isinstance(raw_summary, dict):
        return False, False, _synthetic_failures(operations, "summary missing/not object"), None, \
            warnings + ["summary not dict"]

    try:
        total = _strict_int(raw_summary.get("total"), "summary.total")
        executed = _strict_int(raw_summary.get("executed"), "summary.executed")
        succeeded = _strict_int(raw_summary.get("succeeded"), "summary.succeeded")
        failed = _strict_int(raw_summary.get("failed"), "summary.failed")
        skipped = _strict_int(raw_summary.get("skipped"), "summary.skipped")
    except OfficeCLIOutputError as e:
        return False, False, _synthetic_failures(operations, str(e)), None, warnings + [str(e)]

    rolled_back = raw_summary.get("atomicRolledBack", False)
    if not isinstance(rolled_back, bool):
        return False, False, _synthetic_failures(
            operations, "summary.atomicRolledBack must be bool"
        ), None, warnings + ["atomicRolledBack wrong type"]

    # Cross-checks
    if total != num_ops:
        return False, False, _synthetic_failures(operations, f"summary.total={total} != ops={num_ops}"), \
            None, warnings + ["total mismatch"]
    if executed != len(raw_results):
        return False, False, _synthetic_failures(operations, f"summary.executed={executed} != results={len(raw_results)}"), \
            None, warnings + ["executed mismatch"]
    if succeeded != succeeded_count:
        return False, False, _synthetic_failures(operations, f"summary.succeeded={succeeded} != actual={succeeded_count}"), \
            None, warnings + ["succeeded mismatch"]
    if failed != failed_count:
        return False, False, _synthetic_failures(operations, f"summary.failed={failed} != actual={failed_count}"), \
            None, warnings + ["failed mismatch"]
    if succeeded + failed != executed:
        return False, False, _synthetic_failures(operations, "succeeded+failed != executed"), \
            None, warnings + ["sum mismatch"]
    if skipped != total - executed:
        return False, False, _synthetic_failures(operations, "skipped != total-executed"), \
            None, warnings + ["skipped mismatch"]

    # Envelope success consistency
    expected_success = (failed == 0)
    if envelope_success != expected_success:
        return False, False, _synthetic_failures(
            operations, "envelope success does not match result summary"
        ), None, warnings + ["envelope success mismatch"]

    expected_returncodes = _BATCH_SUCCESS_RETURNCODES if expected_success else frozenset({1})
    if returncode not in expected_returncodes:
        return False, False, _synthetic_failures(
            operations,
            f"return code {returncode} inconsistent with success={expected_success}",
        ), None, warnings + ["return code mismatch"]
    if expected_success and ((returncode == 2) != bool(raw_warnings)):
        return False, False, _synthetic_failures(
            operations, "batch warning list is inconsistent with return code"
        ), None, warnings + ["warning return code mismatch"]

    summary = BatchSummary(
        total=total, executed=executed, succeeded=succeeded,
        failed=failed, skipped=skipped, atomicRolledBack=rolled_back,
    )

    return envelope_success, True, results, summary, warnings


def _synthetic_failures(operations: list[dict[str, Any]], error: str) -> list[OperationResult]:
    return [
        OperationResult(
            index=i, success=False,
            command=op.get("command") or op.get("op", "unknown"),
            error=error,
        )
        for i, op in enumerate(operations)
    ]


# ---------------------------------------------------------------------------
# Spill file reader — strict, O_NOFOLLOW, exact parent, fail-closed
# ---------------------------------------------------------------------------


def _read_spill_file(
    output_file: str, stdout_data: dict[str, Any], max_size: int,
) -> dict[str, Any]:
    """Read spill file strictly. Raises OfficeCLIOutputError on any problem."""
    import re

    basename = os.path.basename(output_file)
    if not re.match(r"^officecli_batch_[0-9a-f]{32}\.json$", basename):
        raise OfficeCLIOutputError(f"Spill file bad name: {basename}")

    # Restrict parent to exactly tempfile.gettempdir()
    expected_parent = Path(tempfile.gettempdir()).resolve(strict=True)
    candidate = Path(output_file)
    if not candidate.is_absolute():
        raise OfficeCLIOutputError("Spill path must be absolute")
    try:
        candidate_parent = candidate.parent.resolve(strict=True)
    except OSError as e:
        raise OfficeCLIOutputError(f"Cannot resolve spill parent: {e}") from e

    if candidate_parent != expected_parent:
        raise OfficeCLIOutputError(
            f"Spill parent {candidate_parent} != expected {expected_parent}"
        )

    # Open with O_NOFOLLOW to prevent symlink race
    fd = -1
    try:
        fd = os.open(str(candidate), os.O_RDONLY | os.O_NOFOLLOW)
        stat = os.fstat(fd)

        # Must be regular file
        import stat as stat_mod
        if not stat_mod.S_ISREG(stat.st_mode):
            raise OfficeCLIOutputError("Spill file is not a regular file")

        file_size = stat.st_size

        # Cap
        if file_size < 0 or file_size > max_size:
            raise OfficeCLIOutputError(f"Spill file {file_size} > cap {max_size}")

        # Declared size must match
        declared = stdout_data.get("outputSize")
        if not isinstance(declared, int) or isinstance(declared, bool):
            raise OfficeCLIOutputError("outputSize missing or not int")
        if declared != file_size:
            raise OfficeCLIOutputError(
                f"outputSize={declared} != actual={file_size}"
            )

        # Read
        chunks: list[bytes] = []
        remaining = file_size
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) != file_size:
            raise OfficeCLIOutputError("Short read on spill file")

    except OfficeCLIOutputError:
        raise
    except OSError as e:
        raise OfficeCLIOutputError(f"Cannot open/read spill file: {e}") from e

    finally:
        if fd >= 0:
            os.close(fd)
        # Always unlink the validated path
        try:
            os.unlink(str(candidate))
        except OSError:
            pass

    # Parse
    try:
        spill_data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise OfficeCLIOutputError(f"Spill JSON parse failed: {e}") from e

    if not isinstance(spill_data, dict):
        raise OfficeCLIOutputError("Spill content not an object")
    if not isinstance(spill_data.get("results"), list):
        raise OfficeCLIOutputError("Spill missing results array")

    return spill_data


# ---------------------------------------------------------------------------
# Validate output — strict, raises OfficeCLIOutputError on protocol defects
# ---------------------------------------------------------------------------


def _parse_validate_output(
    stdout: str, stderr: str, returncode: int
) -> ValidationResult:
    """Parse validate --json. Raises OfficeCLIOutputError on malformed output."""
    parsed = _parse_json_strict(stdout)  # raises on bad JSON

    success = parsed["success"]

    data = parsed.get("data")
    if not isinstance(data, dict):
        raise OfficeCLIOutputError("validate data not an object")

    count = data.get("count")
    if isinstance(count, bool) or not isinstance(count, int):
        raise OfficeCLIOutputError(f"validate count not int: {type(count).__name__}")

    errors = data.get("errors")
    if not isinstance(errors, list):
        raise OfficeCLIOutputError(f"validate errors not list: {type(errors).__name__}")

    if count != len(errors):
        raise OfficeCLIOutputError(f"validate count={count} != len(errors)={len(errors)}")

    # success consistency
    expected = (count == 0)
    if success != expected:
        raise OfficeCLIOutputError(
            f"validate success={success} inconsistent with count={count}"
        )

    expected_returncodes = _STANDARD_SUCCESS_RETURNCODES if expected else frozenset({1})
    if returncode not in expected_returncodes:
        raise OfficeCLIOutputError(
            f"validate rc={returncode} inconsistent with success={expected}"
        )

    return ValidationResult(success=success, count=count, errors=errors)


# ---------------------------------------------------------------------------
# Create output — raises OfficeCLIOutputError (not RuntimeError)
# ---------------------------------------------------------------------------


def _parse_create_output(stdout: str, stderr: str, returncode: int) -> None:
    """Parse create --json. Raises OfficeCLIOutputError on any failure."""
    parsed = _parse_json_strict(stdout)  # raises on malformed

    if not parsed["success"]:
        detail = parsed.get("data") or parsed.get("message", "unknown")
        raise OfficeCLIOutputError(f"create failed: {detail}")

    data = parsed.get("data")
    message = parsed.get("message")
    if not isinstance(data, str) or not isinstance(message, str):
        raise OfficeCLIOutputError("create success requires string data and message")
    if data != message:
        raise OfficeCLIOutputError("create data and message must match")

    if returncode not in _STANDARD_SUCCESS_RETURNCODES:
        raise OfficeCLIOutputError(f"create rc={returncode}")


# ---------------------------------------------------------------------------
# Main execution flow
# ---------------------------------------------------------------------------


async def execute_batch(
    config: ServiceConfig,
    semaphore: asyncio.Semaphore,
    workspace_base: Path,
    source_resolved: Path | None,
    output_resolved: Path,
    operations: list[dict[str, Any]],
    create_if_missing: bool,
    run_validate: bool,
    best_effort: bool,
) -> ExecuteResponse:
    start = time.monotonic()
    output_key = str(output_resolved)
    output_lock = await _acquire_output_lock(output_key)
    try:
        async with output_lock:
            return await _execute_batch_inner(
                config, semaphore, workspace_base, source_resolved,
                output_resolved, operations, create_if_missing,
                run_validate, best_effort, start,
            )
    finally:
        await _release_output_lock(output_key)


async def _execute_batch_inner(
    config: ServiceConfig,
    semaphore: asyncio.Semaphore,
    workspace_base: Path,
    source_resolved: Path | None,
    output_resolved: Path,
    operations: list[dict[str, Any]],
    create_if_missing: bool,
    run_validate: bool,
    best_effort: bool,
    start: float,
) -> ExecuteResponse:
    warnings: list[str] = []
    workspace_base.mkdir(parents=True, exist_ok=True)
    _assert_workspace_containment(workspace_base, output_resolved, "output path")
    if source_resolved is not None:
        _assert_workspace_containment(workspace_base, source_resolved, "source path")
    output_resolved.parent.mkdir(parents=True, exist_ok=True)
    _assert_workspace_containment(workspace_base, output_resolved, "output path")

    fd, working_path_str = tempfile.mkstemp(
        suffix=output_resolved.suffix, dir=str(output_resolved.parent), prefix=".office-wip-"
    )
    os.close(fd)
    working_path = Path(working_path_str)

    fd2, manifest_path_str = tempfile.mkstemp(suffix=".json", dir="/tmp", prefix="office-manifest-")
    os.close(fd2)
    manifest_path = Path(manifest_path_str)

    try:
        if source_resolved and source_resolved.exists():
            _assert_workspace_containment(workspace_base, source_resolved, "source path")
            shutil.copy2(source_resolved, working_path)
        elif create_if_missing:
            await _run_create(config, semaphore, working_path)
        else:
            raise FileNotFoundError("Source does not exist and create_if_missing is false")

        manifest_path.write_text(json.dumps(operations, ensure_ascii=False), encoding="utf-8")

        argv = [config.officecli_bin, "batch", str(working_path), "--input", str(manifest_path), "--json"]
        if best_effort:
            argv.append("--best-effort")

        async with semaphore:
            stdout, stderr, returncode = await _run_subprocess(config, argv)

        batch_success, contract_valid, results, summary, batch_warnings = _parse_batch_output(
            stdout, stderr, returncode, operations, max_stdout_bytes=config.max_stdout_bytes,
        )
        warnings.extend(batch_warnings)

        should_publish = contract_valid and (batch_success or best_effort)
        if not should_publish:
            return ExecuteResponse(
                success=False, published=False, results=results, summary=summary,
                validation=None, officecli_version=get_officecli_version(config),
                duration_ms=int((time.monotonic() - start) * 1000), warnings=warnings,
            )

        validation_result: ValidationResult | None = None
        if run_validate:
            val_argv = [config.officecli_bin, "validate", str(working_path), "--json"]
            async with semaphore:
                val_stdout, val_stderr, val_rc = await _run_subprocess(config, val_argv)
            validation_result = _parse_validate_output(val_stdout, val_stderr, val_rc)
            if not validation_result.success:
                return ExecuteResponse(
                    success=False, published=False, results=results, summary=summary,
                    validation=validation_result, officecli_version=get_officecli_version(config),
                    duration_ms=int((time.monotonic() - start) * 1000),
                    warnings=warnings + ["Validation failed; not published"],
                )

        _assert_workspace_containment(workspace_base, output_resolved, "output path")
        os.replace(str(working_path), str(output_resolved))
        return ExecuteResponse(
            success=batch_success, published=True, results=results, summary=summary,
            validation=validation_result, officecli_version=get_officecli_version(config),
            duration_ms=int((time.monotonic() - start) * 1000), warnings=warnings,
        )
    except Exception:
        working_path.unlink(missing_ok=True)
        raise
    finally:
        manifest_path.unlink(missing_ok=True)


async def _run_create(config: ServiceConfig, semaphore: asyncio.Semaphore, target: Path) -> None:
    argv = [config.officecli_bin, "create", str(target), "--force", "--locale", "en-US", "--json"]
    async with semaphore:
        stdout, stderr, returncode = await _run_subprocess(config, argv)
    _parse_create_output(stdout, stderr, returncode)
