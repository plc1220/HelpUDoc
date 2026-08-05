#!/usr/bin/env python3
"""Run a guarded live Knowledge map-enrichment evaluation over one local document."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any

from helpudoc_agent.configuration import load_settings
from helpudoc_agent.knowledge_ingestion.enrichment import (
    PROMPT_VERSION,
    REDUCE_PROMPT_VERSION,
    SCHEMA_VERSION,
    WindowEnrichment,
    enrich_processing_window,
    hierarchical_reduce_enrichments,
)
from helpudoc_agent.knowledge_ingestion.pipeline import extract_and_plan_document_with_gemini
from helpudoc_agent.tools.workspace.gemini_client import GeminiClientManager


INPUT_PRICE_PER_MILLION = 0.25
OUTPUT_PRICE_PER_MILLION = 1.50


def _estimated_cost(records: list[dict[str, Any]]) -> float:
    input_tokens = sum(int(record.get("inputTokens") or 0) for record in records)
    output_tokens = sum(int(record.get("outputTokens") or 0) for record in records)
    return (
        input_tokens * INPUT_PRICE_PER_MILLION / 1_000_000
        + output_tokens * OUTPUT_PRICE_PER_MILLION / 1_000_000
    )


async def run(source: Path, output: Path, concurrency: int, max_cost_usd: float) -> None:
    settings = load_settings()
    manager = GeminiClientManager(settings)
    model = manager.get_ingestion_chat_model()
    plan = await extract_and_plan_document_with_gemini(
        source,
        client=manager.client,
        model=manager.lite_model_name,
        ocr_mode="auto",
        cache_root=output.parent / ".ocr-cache",
    )
    ocr_usage = [event.model_dump(mode="json") for event in plan.manifest.modelUsage]
    print(
        f"extraction={plan.manifest.processedSourceUnits}/{plan.manifest.discoveredSourceUnits} "
        f"ocr_input_tokens={sum(item['inputTokens'] for item in ocr_usage)} "
        f"ocr_output_tokens={sum(item['outputTokens'] for item in ocr_usage)}",
        flush=True,
    )
    if _estimated_cost(ocr_usage) > max_cost_usd:
        raise RuntimeError(f"OCR exceeded the ${max_cost_usd:.2f} cost guard before enrichment")
    by_id = {block.id: block for block in plan.blocks}
    structure_by_id = {node.id: node for node in plan.structure}
    map_results: list[dict[str, Any] | None] = [None] * len(plan.windows)
    usage_by_window: list[dict[str, Any]] = []
    checkpoint = output.parent / ".map-checkpoint.json"
    checkpoint_key = hashlib.sha256(json.dumps({
        "source": str(source.resolve()),
        "size": source.stat().st_size,
        "modifiedNs": source.stat().st_mtime_ns,
        "model": manager.lite_model_name,
        "promptVersion": PROMPT_VERSION,
        "schemaVersion": SCHEMA_VERSION,
        "windows": [{"id": item.id, "contentHash": item.contentHash} for item in plan.windows],
    }, sort_keys=True).encode("utf-8")).hexdigest()
    # Reuse prior final output by window content hash even if recovery adds or
    # reorders pages and therefore changes the document-level checkpoint key.
    if output.exists():
        prior = json.loads(output.read_text(encoding="utf-8"))
        prior_windows = prior.get("windows") or []
        prior_results = prior.get("rawMapResults") or []
        prior_by_hash = {
            str(window.get("contentHash")): result
            for window, result in zip(prior_windows, prior_results)
            if window.get("contentHash") and result
        }
        prior_hash_by_id = {
            str(window.get("id")): str(window.get("contentHash"))
            for window in prior_windows
            if window.get("id") and window.get("contentHash")
        }
        prior_usage_by_hash = {
            prior_hash_by_id[str(item.get("windowId"))]: item
            for item in (prior.get("usage", {}).get("windows") or [])
            if item.get("windowId") and str(item.get("windowId")) in prior_hash_by_id
        }
        for index, window in enumerate(plan.windows):
            if cached_result := prior_by_hash.get(window.contentHash):
                map_results[index] = cached_result
                if cached_usage := prior_usage_by_hash.get(window.contentHash):
                    usage_by_window.append(cached_usage)
    if checkpoint.exists():
        cached = json.loads(checkpoint.read_text(encoding="utf-8"))
        if cached.get("key") == checkpoint_key:
            cached_results = cached.get("results") or []
            for index, result in enumerate(cached_results[:len(map_results)]):
                map_results[index] = result
            usage_by_window = list(cached.get("usage") or [])
            print(
                f"resumed_map_windows={sum(result is not None for result in map_results)}/"
                f"{len(map_results)}",
                flush=True,
            )

    async def enrich(index: int) -> tuple[int, dict[str, Any], dict[str, Any]]:
        window = plan.windows[index]
        block_ids = list(dict.fromkeys([
            *window.contextBeforeBlockIds,
            *window.coreBlockIds,
            *window.contextAfterBlockIds,
        ]))
        blocks = [by_id[block_id] for block_id in block_ids if block_id in by_id]
        structure = structure_by_id.get(window.structureNodeId)
        usage: list[dict[str, Any]] = []
        validation_warnings: list[str] = []
        result = await enrich_processing_window(
            model,
            window=window,
            blocks=blocks,
            source_type=plan.manifest.sourceType,
            language_distribution=plan.languageDistribution,
            structural_path=[structure.title] if structure else [],
            usage_records=usage,
            validation_warnings=validation_warnings,
        )
        response = {
            "result": result.model_dump(mode="json"),
            "provider": "google-vertex-ai",
            "model": manager.lite_model_name,
            "modelProfile": "lite",
            "promptVersion": PROMPT_VERSION,
            "schemaVersion": SCHEMA_VERSION,
        }
        usage_record = {
            "windowId": window.id,
            "structureTitle": structure.title if structure else None,
            "attempts": usage,
            "inputTokens": sum(item["inputTokens"] for item in usage),
            "outputTokens": sum(item["outputTokens"] for item in usage),
            "estimatedCostUsd": round(_estimated_cost(usage), 8),
            "validationWarnings": validation_warnings,
        }
        return index, response, usage_record

    width = max(1, min(concurrency, 16))
    pending_indexes = [index for index, result in enumerate(map_results) if result is None]
    for offset in range(0, len(pending_indexes), width):
        batch = pending_indexes[offset:offset + width]
        completed = await asyncio.gather(*(enrich(index) for index in batch))
        for index, response, usage_record in completed:
            map_results[index] = response
            usage_by_window.append(usage_record)
        checkpoint.parent.mkdir(parents=True, exist_ok=True)
        checkpoint_tmp = checkpoint.with_suffix(".json.tmp")
        checkpoint_tmp.write_text(json.dumps({
            "key": checkpoint_key,
            "results": map_results,
            "usage": usage_by_window,
        }, ensure_ascii=False), encoding="utf-8")
        checkpoint_tmp.replace(checkpoint)
        all_attempts = [attempt for item in usage_by_window for attempt in item["attempts"]]
        cost = _estimated_cost(all_attempts)
        print(
            f"progress={len(usage_by_window)}/{len(plan.windows)} "
            f"input_tokens={sum(item['inputTokens'] for item in usage_by_window)} "
            f"output_tokens={sum(item['outputTokens'] for item in usage_by_window)} "
            f"estimated_cost_usd={cost:.6f}",
            flush=True,
        )
        if cost > max_cost_usd:
            raise RuntimeError(
                f"Live enrichment exceeded the ${max_cost_usd:.2f} cost guard after "
                f"{len(usage_by_window)} windows"
            )

    finalized_results = [result for result in map_results if result is not None]
    reduction_usage: list[dict[str, Any]] = []
    reduced = await hierarchical_reduce_enrichments(
        model,
        results=[
            WindowEnrichment.model_validate(result["result"])
            for result in finalized_results
        ],
        blocks=plan.blocks,
        usage_records=reduction_usage,
    )
    reduced_response = {
        "result": reduced.model_dump(mode="json"),
        "provider": "google-vertex-ai",
        "model": manager.lite_model_name,
        "modelProfile": "lite",
        "promptVersion": REDUCE_PROMPT_VERSION,
        "schemaVersion": SCHEMA_VERSION,
    }
    total_input = (
        sum(item["inputTokens"] for item in usage_by_window)
        + sum(int(item.get("inputTokens") or 0) for item in ocr_usage)
        + sum(int(item.get("inputTokens") or 0) for item in reduction_usage)
    )
    total_output = (
        sum(item["outputTokens"] for item in usage_by_window)
        + sum(int(item.get("outputTokens") or 0) for item in ocr_usage)
        + sum(int(item.get("outputTokens") or 0) for item in reduction_usage)
    )
    payload = {
        "sourcePath": source.as_posix(),
        "title": plan.title,
        "summary": plan.summary,
        "markdown": plan.markdown,
        "manifest": plan.manifest.model_dump(mode="json"),
        "blocks": [block.model_dump(mode="json") for block in plan.blocks],
        "structure": [node.model_dump(mode="json") for node in plan.structure],
        "windows": [window.model_dump(mode="json") for window in plan.windows],
        "languageDistribution": plan.languageDistribution,
        "rawMapResults": finalized_results,
        # The reducer supplies global aliases/edges; the raw map outputs remain
        # part of canonicalization so reduction can never become a lossy gate.
        "mapResults": [*finalized_results, reduced_response],
        "usage": {
            "inputTokens": total_input,
            "outputTokens": total_output,
            "estimatedCostUsd": round(
                total_input * INPUT_PRICE_PER_MILLION / 1_000_000
                + total_output * OUTPUT_PRICE_PER_MILLION / 1_000_000,
                8,
            ),
            "windows": usage_by_window,
            "ocr": ocr_usage,
            "reduce": reduction_usage,
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(output)
    print(f"output={output}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--max-cost-usd", type=float, default=0.50)
    args = parser.parse_args()
    asyncio.run(run(args.source, args.output, args.concurrency, args.max_cost_usd))


if __name__ == "__main__":
    main()
