"""Run MarkItDown in a child process with a time limit.

On a large PDF, MarkItDown's pdfminer pass is most of the extraction time: 25 of 26
seconds for a 437-page annual report, against about one second for the native
PyMuPDF blocks. It is pure Python, so in a thread it still holds the interpreter
lock and slows every chat in the agent, and a thread cannot be stopped when it
overruns. A child process has neither problem: it runs on its own CPU, and on
timeout or cancellation it is killed.

MarkItDown only supplies the Markdown body for formats that have native extraction
(PDF, DOCX, ...). When it fails or times out, the caller keeps the native Markdown
and records a markitdown_fallback warning, so the source still builds.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import weakref
from pathlib import Path

from .conversion import MarkItDownConversion

DEFAULT_TIMEOUT_SECONDS = 120.0
# Two concurrent children match the knowledge worker's default concurrency of two
# runs. One semaphore per event loop: an asyncio primitive must not cross loops.
_MAX_CHILDREN = 2
_SLOTS: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


def _slots() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    slots = _SLOTS.get(loop)
    if slots is None:
        slots = _SLOTS[loop] = asyncio.Semaphore(_MAX_CHILDREN)
    return slots


def markitdown_timeout_seconds() -> float:
    raw = os.environ.get("KNOWLEDGE_MARKITDOWN_TIMEOUT_SECONDS", "").strip()
    try:
        value = float(raw) if raw else DEFAULT_TIMEOUT_SECONDS
    except ValueError:
        return DEFAULT_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_TIMEOUT_SECONDS


def _worker_command(path: Path) -> list[str]:
    return [sys.executable, "-m", "helpudoc_agent.knowledge_ingestion.markitdown_worker", str(path)]


def _worker_env() -> dict[str, str]:
    # The agent starts from /app/agent; make the package importable from any cwd.
    package_root = str(Path(__file__).resolve().parents[2])
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [package_root, env.get("PYTHONPATH", "")]))
    return env


async def convert_with_markitdown_isolated(
    path: Path,
    *,
    timeout_seconds: float | None = None,
) -> MarkItDownConversion:
    """Convert one local file in a child process. Raises on failure or timeout."""
    timeout = timeout_seconds if timeout_seconds is not None else markitdown_timeout_seconds()
    async with _slots():
        process = await asyncio.create_subprocess_exec(
            *_worker_command(path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_worker_env(),
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            await _kill(process)
            raise TimeoutError(f"MarkItDown exceeded {timeout:g}s") from None
        except BaseException:
            # Cancellation (for example the backend gave up) must not leave the child running.
            await _kill(process)
            raise
    if process.returncode != 0:
        detail = stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["no output"]
        raise RuntimeError(f"MarkItDown worker exited {process.returncode}: {detail[0][:300]}")
    payload = json.loads(stdout.decode("utf-8"))
    return MarkItDownConversion(
        markdown=str(payload.get("markdown") or ""),
        title=payload.get("title"),
        converter=str(payload.get("converter") or "markitdown/unknown"),
    )


async def _kill(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        process.kill()
        await process.wait()
