"""Gate direct OfficeCLI on non-document P99 latency in the agent cgroup."""

from __future__ import annotations

import asyncio
import json
import math
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time
import urllib.request

AGENT_ROOT = Path(__file__).resolve().parents[1]
if str(AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENT_ROOT))

from helpudoc_agent.tools.workspace.office.config import OfficeRunnerConfig
from helpudoc_agent.tools.workspace.office.runner import execute_batch, is_binary_ready


def _latency_ms(url: str) -> float:
    started = time.perf_counter()
    with urllib.request.urlopen(url, timeout=2) as response:
        if response.status != 200:
            raise RuntimeError(f"latency probe returned HTTP {response.status}")
        response.read()
    return (time.perf_counter() - started) * 1000


async def _sample(url: str, count: int) -> list[float]:
    return [await asyncio.to_thread(_latency_ms, url) for _ in range(count)]


def _p99(samples: list[float]) -> float:
    if not samples:
        raise RuntimeError("no latency samples were collected")
    ordered = sorted(samples)
    return ordered[max(0, math.ceil(len(ordered) * 0.99) - 1)]


async def _run() -> None:
    config = OfficeRunnerConfig()
    if not await asyncio.to_thread(is_binary_ready, config):
        raise RuntimeError("pinned OfficeCLI is not ready")
    url = os.getenv("HELPUDOC_LATENCY_PROBE_URL", "http://127.0.0.1:8001/health")
    max_degradation = float(os.getenv("HELPUDOC_OFFICECLI_P99_MAX_DEGRADATION", "0.20"))
    slo_raw = os.getenv("HELPUDOC_NON_DOCUMENT_P99_SLO_MS", "").strip()
    slo_ms = float(slo_raw) if slo_raw else None
    sample_count = int(os.getenv("HELPUDOC_OFFICECLI_P99_SAMPLES", "120"))
    if sample_count < 30:
        raise RuntimeError("HELPUDOC_OFFICECLI_P99_SAMPLES must be at least 30")
    workspace_parent = os.getenv("WORKSPACE_ROOT", "/app/workspaces")
    Path(workspace_parent).mkdir(parents=True, exist_ok=True)

    await _sample(url, 10)  # remove connection/import warm-up from the baseline
    baseline = await _sample(url, sample_count)

    with tempfile.TemporaryDirectory(prefix="helpudoc-office-cgroup-", dir=workspace_parent) as tmp:
        workspace = Path(tmp) / "workspace"
        workspace.mkdir()
        output = workspace / "max-batch.docx"
        workload = asyncio.create_task(
            execute_batch(
                config=config,
                semaphore=asyncio.Semaphore(1),
                workspace_base=workspace,
                source_resolved=None,
                output_resolved=output,
                operations=[{"command": "view", "mode": "stats"} for _ in range(50)],
                create_if_missing=True,
            )
        )
        loaded: list[float] = []
        while not workload.done() or len(loaded) < sample_count:
            loaded.append(await asyncio.to_thread(_latency_ms, url))
            if len(loaded) >= sample_count and workload.done():
                break
        result = await workload
        if not result.success or not result.published or result.validation is None:
            raise RuntimeError(f"50-operation OfficeCLI workload failed: {result.model_dump(mode='json')}")

    baseline_p99 = _p99(baseline)
    loaded_p99 = _p99(loaded)
    degradation = (loaded_p99 / baseline_p99) - 1.0
    passed = loaded_p99 <= slo_ms if slo_ms is not None else degradation <= max_degradation
    report = {
        "status": "ok" if passed else "failed",
        "probe_url": url,
        "baseline_samples": len(baseline),
        "loaded_samples": len(loaded),
        "baseline_p99_ms": round(baseline_p99, 3),
        "loaded_p99_ms": round(loaded_p99, 3),
        "degradation": round(degradation, 4),
        "max_degradation": max_degradation,
        "p99_slo_ms": slo_ms,
        "loaded_median_ms": round(statistics.median(loaded), 3),
    }
    print(json.dumps(report, separators=(",", ":")))
    if not passed:
        limit = f"{slo_ms:.3f}ms SLO" if slo_ms is not None else f"{max_degradation:.1%} degradation"
        raise RuntimeError(
            f"shared-cgroup loaded P99 was {loaded_p99:.3f}ms; limit is {limit}"
        )


if __name__ == "__main__":
    asyncio.run(_run())
