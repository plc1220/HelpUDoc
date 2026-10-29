"""Run blocking ingestion work off the agent's event loop.

The agent serves chat, streaming and the Kubernetes health probes from one event
loop. Document extraction, preflight and graph analysis are synchronous. Called
directly from an async route they freeze that loop: /health stops answering, the
liveness probe kills the agent, and every in-flight ingestion job fails with
"socket hang up" or ECONNREFUSED. The pre-OKF pipeline avoided this with
asyncio.to_thread; it was lost when that pipeline was replaced.

Two pools, because the work has two different safety rules:

- PyMuPDF (fitz) must never be used from two threads at once. Its documentation
  says multithreading "may cause incorrect behaviour or even crash Python itself".
  Every fitz call in knowledge ingestion therefore goes through run_pymupdf, which
  owns the only thread that touches MuPDF. That work is fast (about one second for
  a 437-page report), so one thread is enough.
- Pure-Python work such as graph analysis is thread-safe and uses run_blocking.

The slow part of a large PDF is MarkItDown's pdfminer pass, which runs in a child
process instead (see markitdown_isolated) so it cannot hold the interpreter lock in
the agent and can be killed when it overruns.
"""
from __future__ import annotations

import asyncio
import functools
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, TypeVar

T = TypeVar("T")

PYMUPDF_THREAD_NAME = "pymupdf"

_PYMUPDF_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix=PYMUPDF_THREAD_NAME)
# Two workers match the knowledge worker's default concurrency of two runs.
_CPU_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="knowledge-cpu")


async def run_pymupdf(fn: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    """Await a call that uses PyMuPDF, on the single thread allowed to use it."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_PYMUPDF_EXECUTOR, functools.partial(fn, *args, **kwargs))


async def run_blocking(fn: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    """Await a thread-safe synchronous call that must not use PyMuPDF."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_CPU_EXECUTOR, functools.partial(fn, *args, **kwargs))
