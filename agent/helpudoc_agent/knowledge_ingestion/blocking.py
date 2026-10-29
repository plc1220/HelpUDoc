"""Run CPU-bound ingestion work off the agent's event loop.

The agent serves chat, streaming and the Kubernetes health probes from one event
loop. Document extraction (markitdown, pdfminer, PyMuPDF), preflight and graph
analysis are synchronous, and on a large report they run for minutes. Called
directly from an async route they freeze that loop: /health stops answering, the
liveness probe kills the agent, and every in-flight ingestion job fails with
"socket hang up" or ECONNREFUSED. The pre-OKF pipeline avoided this with
asyncio.to_thread; it was lost when that pipeline was replaced.

A thread does not make pure-Python extraction run in parallel with the loop, but
the interpreter switches threads every few milliseconds, so probes and streams keep
getting answered while a large document is read.
"""
from __future__ import annotations

import asyncio
import functools
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, TypeVar

T = TypeVar("T")

# Two workers match the knowledge worker's default concurrency of two runs, so two
# large uploads cannot take every core from chat.
_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="knowledge-cpu")


async def run_blocking(fn: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    """Await a synchronous call on the ingestion thread pool."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_EXECUTOR, functools.partial(fn, *args, **kwargs))
