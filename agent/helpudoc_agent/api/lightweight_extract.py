"""Backward-compatible entrypoint for the versioned Knowledge extractor."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from helpudoc_agent.knowledge_ingestion import (
    extract_and_plan_document,
    extract_and_plan_document_with_gemini,
)


def extract_workspace_document(path: Path, *, include_plan: bool = False) -> dict[str, Any]:
    plan = extract_and_plan_document(path).model_dump(mode="json")
    if include_plan:
        return plan
    return {key: plan[key] for key in ("title", "summary", "markdown")}


async def extract_workspace_document_with_gemini(
    path: Path,
    *,
    client: object,
    model: str,
    include_plan: bool = False,
    ocr_mode: str | None = None,
) -> dict[str, Any]:
    plan = (await extract_and_plan_document_with_gemini(
        path,
        client=client,
        model=model,
        ocr_mode=ocr_mode,
    )).model_dump(mode="json")
    if include_plan:
        return plan
    return {key: plan[key] for key in ("title", "summary", "markdown")}
