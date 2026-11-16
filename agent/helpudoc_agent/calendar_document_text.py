"""Bounded deterministic document text extraction without app secrets or tools.

Linux workers enforce a hard 512 MiB address-space limit. Darwin lacks RLIMIT_AS;
there the parent also samples worker RSS at a 50 ms target interval and kills the
process group above 512 MiB. RSS may overshoot between samples. Failure to observe
memory fails closed. Both paths retain input/ZIP/CPU/output and 8 s wall bounds.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
from pathlib import Path
import signal
import sys
import tempfile

MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_BASE64_LENGTH = ((MAX_INPUT_BYTES + 2) // 3) * 4
MAX_REQUEST_BYTES = MAX_BASE64_LENGTH + 4096
MAX_OUTPUT_BYTES = 65536
SUPPORTED_MIME = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
}
_WORKERS = asyncio.Semaphore(2)
_WORKER = Path(__file__).with_name("calendar_document_text_worker.py").resolve()
_RSS_WATCHDOG = sys.platform == "darwin"
_RSS_LIMIT_KIB = 512 * 1024


class DocumentTextError(Exception):
    def __init__(self, code: str, status_code: int = 422):
        self.code, self.status_code = code, status_code
        super().__init__("Document text was unavailable within the supported briefing limits.")


def decode_content(content: str) -> bytes:
    if not isinstance(content, str) or not content or len(content) > MAX_BASE64_LENGTH:
        raise DocumentTextError("DOCUMENT_TEXT_LIMIT", 413)
    try:
        result = base64.b64decode(content, validate=True)
    except (ValueError, TypeError) as exc:
        raise DocumentTextError("DOCUMENT_TEXT_UNREADABLE") from exc
    if not result or len(result) > MAX_INPUT_BYTES:
        raise DocumentTextError("DOCUMENT_TEXT_LIMIT", 413)
    return result


def worker_environment(home: str) -> dict[str, str]:
    # Do not inherit credentials, proxy settings, Python hooks, or agent context.
    environment = {"PATH": os.defpath, "HOME": home, "TMPDIR": home, "LANG": "C.UTF-8", "PYTHONIOENCODING": "utf-8"}
    if _RSS_WATCHDOG:
        environment["CALENDAR_DOCUMENT_RSS_WATCHDOG"] = "1"
    return environment


async def _bounded(stream, limit: int) -> bytes:
    result = bytearray()
    while True:
        chunk = await stream.read(min(4096, limit + 1 - len(result)))
        if not chunk:
            return bytes(result)
        result.extend(chunk)
        if len(result) > limit:
            raise DocumentTextError("DOCUMENT_TEXT_LIMIT")


async def _rss_kib(pid: int, directory: str) -> int | None:
    """Fixed OS observer command; the PID comes only from our subprocess handle."""
    probe = None
    try:
        probe = await asyncio.create_subprocess_exec(
            "/bin/ps", "-o", "rss=", "-p", str(pid),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            cwd=directory, env=worker_environment(directory),
        )
        output = await asyncio.wait_for(_bounded(probe.stdout, 128), 0.5)
        status = await asyncio.wait_for(probe.wait(), 0.5)
        if status == 1 and not output.strip():
            return None  # process may have completed before the observation
        if status != 0 or not output.strip().isdigit():
            raise DocumentTextError("DOCUMENT_TEXT_UNSUPPORTED", 503)
        return int(output.strip())
    except (OSError, TimeoutError) as exc:
        raise DocumentTextError("DOCUMENT_TEXT_UNSUPPORTED", 503) from exc
    finally:
        if probe and probe.returncode is None:
            probe.kill()
            await probe.wait()


async def _watch_rss(process, directory: str) -> None:
    while process.returncode is None:
        rss = await _rss_kib(process.pid, directory)
        if rss is None:
            try:
                await asyncio.wait_for(asyncio.shield(process.wait()), 0.02)
                return
            except TimeoutError as exc:
                raise DocumentTextError("DOCUMENT_TEXT_UNSUPPORTED", 503) from exc
        if rss > _RSS_LIMIT_KIB:
            raise DocumentTextError("DOCUMENT_TEXT_LIMIT")
        await asyncio.sleep(0.05)


async def extract_document_text(data: bytes, mime_type: str, *, timeout_seconds: float = 8) -> dict:
    if not isinstance(data, bytes) or not data or len(data) > MAX_INPUT_BYTES:
        raise DocumentTextError("DOCUMENT_TEXT_LIMIT", 413)
    if mime_type not in SUPPORTED_MIME or os.name != "posix":
        raise DocumentTextError("DOCUMENT_TEXT_UNSUPPORTED", 503)
    process = None
    tasks = []
    try:
        async with asyncio.timeout(min(8, max(0.05, timeout_seconds))):
            async with _WORKERS:
                with tempfile.TemporaryDirectory(prefix="lumo-calendar-document-") as directory:
                    try:
                        process = await asyncio.create_subprocess_exec(
                            sys.executable, "-I", "-B", str(_WORKER), SUPPORTED_MIME[mime_type],
                            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                            cwd=directory, env=worker_environment(directory), start_new_session=True,
                        )

                        async def feed():
                            try:
                                process.stdin.write(data)
                                await process.stdin.drain()
                                process.stdin.close()
                                await process.stdin.wait_closed()
                            except (BrokenPipeError, ConnectionResetError):
                                pass

                        tasks = [asyncio.create_task(_bounded(process.stdout, MAX_OUTPUT_BYTES)), asyncio.create_task(_bounded(process.stderr, 8192)), asyncio.create_task(feed()), asyncio.create_task(process.wait())]
                        if _RSS_WATCHDOG:
                            tasks.append(asyncio.create_task(_watch_rss(process, directory)))
                        results = await asyncio.gather(*tasks)
                        stdout, returncode = results[0], results[3]
                        if returncode != 0:
                            raise DocumentTextError("DOCUMENT_TEXT_LIMIT")
                        try:
                            result = json.loads(stdout)
                        except (ValueError, UnicodeError) as exc:
                            raise DocumentTextError("DOCUMENT_TEXT_UNREADABLE") from exc
                        if result.get("error"):
                            code = result["error"] if result["error"] in {"DOCUMENT_TEXT_UNSUPPORTED", "DOCUMENT_TEXT_LIMIT", "DOCUMENT_TEXT_UNREADABLE"} else "DOCUMENT_TEXT_UNREADABLE"
                            raise DocumentTextError(code, 503 if code == "DOCUMENT_TEXT_UNSUPPORTED" else 422)
                        text, gaps = result.get("text"), result.get("gaps")
                        if not isinstance(text, str) or len(text.encode("utf-16-le")) // 2 > 12000 or not isinstance(gaps, list) or len(gaps) > 20 or any(not isinstance(gap, str) or len(gap) > 500 for gap in gaps):
                            raise DocumentTextError("DOCUMENT_TEXT_LIMIT")
                        return {"text": text, "gaps": gaps}
                    finally:
                        if process and process.returncode is None:
                            try:
                                os.killpg(process.pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                            await process.wait()
                        for task in tasks:
                            if not task.done():
                                task.cancel()
                        if tasks:
                            await asyncio.gather(*tasks, return_exceptions=True)
    except TimeoutError as exc:
        raise DocumentTextError("DOCUMENT_TEXT_TIMEOUT", 503) from exc
    except (OSError, NotImplementedError) as exc:
        raise DocumentTextError("DOCUMENT_TEXT_UNSUPPORTED", 503) from exc
