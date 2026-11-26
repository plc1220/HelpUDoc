"""In-memory run checkpoints that do not grow without bound.

MemorySaver keeps every checkpoint of every run. Each one that changes the messages holds
a full copy of them, attachments included: about 209 MB for one 18-step run with a 4 MB
file, never freed. In production four long runs took the agent from 1.3 to 8.3 GB of its
9 GB limit.

A resume needs only the newest checkpoint of a thread and its pending writes, and nothing
in Lumo reads checkpoint history. So:

- While a run works, each thread keeps its newest few checkpoints per namespace.
- When a run ends, its thread is reduced to the newest one. It is not deleted: the backend
  can turn a run the agent saw as finished into one waiting for the user, and then resume
  the same thread. Finished threads are dropped oldest first above a total size.
- Threads waiting for the user are never dropped for size, only after the 24 hours for
  which the backend keeps a run's record. After that nothing can answer them.

Every cleanup step is best effort: a failure keeps the data and never fails a run.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

from langgraph.checkpoint.memory import MemorySaver

logger = logging.getLogger(__name__)

# More than one, so a late write or an inspection of the previous step still resolves.
KEEP_WHILE_RUNNING = 3
# The backend keeps run records for 24 hours (STREAM_TTL_SECONDS).
WAITING_TTL_SECONDS = 24 * 60 * 60
FINISHED_MAX_BYTES = 256 * 1024 * 1024
_SWEEP_INTERVAL_SECONDS = 300


class BoundedMemorySaver(MemorySaver):
    def __init__(self, *, clock: Callable[[], float] = time.monotonic, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._clock = clock
        self._lock = threading.RLock()
        self._finished: dict[str, float] = {}  # thread id -> when it ended, oldest first
        self._waiting: dict[str, float] = {}
        self._last_sweep = clock()

    def put(self, config, checkpoint, metadata, new_versions):
        with self._lock:
            result = super().put(config, checkpoint, metadata, new_versions)
            thread_id = config["configurable"]["thread_id"]
            # In use again (a resume), or the last checkpoint of a pause committing late.
            self._finished.pop(thread_id, None)
            if thread_id in self._waiting:
                self._waiting[thread_id] = self._clock()
            self._quietly(self._prune, thread_id, KEEP_WHILE_RUNNING)
            return result

    def delete_thread(self, thread_id: str) -> None:
        with self._lock:
            self._finished.pop(thread_id, None)
            self._waiting.pop(thread_id, None)
            super().delete_thread(thread_id)

    def mark_finished(self, thread_id: str) -> None:
        """The run ended and nothing is waiting for the user."""
        with self._lock:
            if thread_id in self.storage:
                self._quietly(self._prune, thread_id, 1)
                self._waiting.pop(thread_id, None)
                self._finished.pop(thread_id, None)
                self._finished[thread_id] = self._clock()
            self._quietly(self._sweep)

    def mark_waiting(self, thread_id: str) -> None:
        """The run paused for the user. Kept in full: its last checkpoint may still be committing."""
        with self._lock:
            self._finished.pop(thread_id, None)
            self._waiting[thread_id] = self._clock()
            self._quietly(self._sweep)

    def total_bytes(self) -> int:
        with self._lock:
            return sum(len(value[1]) for value in self.blobs.values())

    @staticmethod
    def _quietly(function: Callable[..., None], *args: Any) -> None:
        try:
            function(*args)
        except Exception:
            logger.warning("Checkpoint cleanup skipped", exc_info=True)

    def _prune(self, thread_id: str, keep: int) -> None:
        namespaces = self.storage.get(thread_id)
        if not namespaces:
            return
        used: set[tuple] = set()
        kept: set[tuple[str, str]] = set()
        for namespace, checkpoints in namespaces.items():
            # Checkpoint ids sort by time (uuid6); MemorySaver itself relies on it.
            for checkpoint_id in sorted(checkpoints)[:-keep]:
                del checkpoints[checkpoint_id]
            for checkpoint_id, saved in checkpoints.items():
                kept.add((namespace, checkpoint_id))
                versions = self.serde.loads_typed(saved[0]).get("channel_versions", {})
                used.update((thread_id, namespace, channel, version) for channel, version in versions.items())
        for key in [k for k in self.blobs if k[0] == thread_id and k not in used]:
            del self.blobs[key]
        newest = {namespace: max(ids) for namespace, ids in namespaces.items() if ids}
        for key in [k for k in self.writes if k[0] == thread_id]:
            # Writes can arrive before their checkpoint does: keep anything not older.
            if (key[1], key[2]) not in kept and key[2] < newest.get(key[1], ""):
                del self.writes[key]

    def _sweep(self) -> None:
        now = self._clock()
        sizes: dict[str, int] = {}
        for key, value in self.blobs.items():
            if key[0] in self._finished:
                sizes[key[0]] = sizes.get(key[0], 0) + len(value[1])
        total = sum(sizes.values())
        for thread_id in list(self._finished):
            if total <= FINISHED_MAX_BYTES and now - self._finished[thread_id] < WAITING_TTL_SECONDS:
                continue
            total -= sizes.get(thread_id, 0)
            self.delete_thread(thread_id)
        if now - self._last_sweep < _SWEEP_INTERVAL_SECONDS:
            return
        self._last_sweep = now
        for thread_id, since in list(self._waiting.items()):
            if now - since >= WAITING_TTL_SECONDS:
                self.delete_thread(thread_id)
            elif now - since >= _SWEEP_INTERVAL_SECONDS:
                self._quietly(self._prune, thread_id, 1)


async def settle_run_thread(agent: Any, saver: Any, config: Any, *, saw_interrupt: bool) -> None:
    """Record how a run's thread ended. When unsure, treat it as waiting for the user."""
    try:
        thread_id = str((config or {}).get("configurable", {}).get("thread_id") or "")
        if not thread_id or not isinstance(saver, BoundedMemorySaver):
            return
        waiting = saw_interrupt
        if not waiting:
            state = await agent.aget_state(config, subgraphs=True)
            waiting = bool(getattr(state, "interrupts", ()) or ())
        if waiting:
            saver.mark_waiting(thread_id)
        else:
            saver.mark_finished(thread_id)
    except Exception:
        logger.warning("Run checkpoint could not be settled; kept", exc_info=True)
