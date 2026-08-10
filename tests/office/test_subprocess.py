"""Process-boundary tests for the direct OfficeCLI runner."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from agent.helpudoc_agent.tools.workspace.office.config import OfficeRunnerConfig
from agent.helpudoc_agent.tools.workspace.office.runner import (
    OfficeCLIOutputError,
    _run_subprocess,
)


def _write_script(path: Path, body: str) -> Path:
    path.write_text("#!/bin/sh\nset -eu\n" + body, encoding="utf-8")
    path.chmod(0o755)
    return path


async def _assert_process_stopped(pid: int) -> None:
    """Wait briefly for init to reap a killed descendant."""
    for _ in range(40):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        await asyncio.sleep(0.05)
    try:
        state = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").split()[2]
    except (FileNotFoundError, IndexError, OSError):
        state = ""
    assert state == "Z", f"descendant process {pid} is still running"


@pytest.mark.asyncio
async def test_timeout_kills_entire_process_group(tmp_path: Path) -> None:
    pid_file = tmp_path / "child.pid"
    script = _write_script(
        tmp_path / "hang",
        f"sleep 300 &\necho $! > {pid_file!s}\nwait\n",
    )
    config = OfficeRunnerConfig(timeout_seconds=1)

    with pytest.raises(asyncio.TimeoutError):
        await _run_subprocess(config, [str(script)])

    await _assert_process_stopped(int(pid_file.read_text().strip()))


@pytest.mark.asyncio
async def test_timeout_kills_background_child_after_parent_exits(tmp_path: Path) -> None:
    pid_file = tmp_path / "child.pid"
    script = _write_script(
        tmp_path / "orphan",
        f"sleep 300 &\necho $! > {pid_file!s}\nexit 0\n",
    )
    config = OfficeRunnerConfig(timeout_seconds=1)

    with pytest.raises(asyncio.TimeoutError):
        await _run_subprocess(config, [str(script)])

    await _assert_process_stopped(int(pid_file.read_text().strip()))


@pytest.mark.asyncio
async def test_stdout_limit_kills_process(tmp_path: Path) -> None:
    script = _write_script(
        tmp_path / "stdout-flood",
        "python3 -c 'import sys; sys.stdout.buffer.write(b\"x\" * 4096)'\n",
    )
    config = OfficeRunnerConfig(max_stdout_bytes=1024)

    with pytest.raises(OfficeCLIOutputError, match="stdout exceeded 1024 bytes"):
        await _run_subprocess(config, [str(script)])


@pytest.mark.asyncio
async def test_stderr_limit_kills_process(tmp_path: Path) -> None:
    script = _write_script(
        tmp_path / "stderr-flood",
        "python3 -c 'import sys; sys.stderr.buffer.write(b\"x\" * 4096)'\n",
    )
    config = OfficeRunnerConfig(max_stderr_bytes=1024)

    with pytest.raises(OfficeCLIOutputError, match="stderr exceeded 1024 bytes"):
        await _run_subprocess(config, [str(script)])


@pytest.mark.asyncio
async def test_cancellation_kills_and_reaps_process_group(tmp_path: Path) -> None:
    pid_file = tmp_path / "child.pid"
    script = _write_script(
        tmp_path / "cancel",
        f"sleep 300 &\necho $! > {pid_file!s}\nwait\n",
    )
    task = asyncio.create_task(
        _run_subprocess(OfficeRunnerConfig(timeout_seconds=60), [str(script)])
    )
    for _ in range(40):
        if pid_file.exists():
            break
        await asyncio.sleep(0.05)
    assert pid_file.exists()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=2)

    await _assert_process_stopped(int(pid_file.read_text().strip()))
