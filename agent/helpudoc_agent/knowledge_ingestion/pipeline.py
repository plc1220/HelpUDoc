"""Extraction-to-window pipeline used by the internal Knowledge API."""
from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Callable

from .blocking import run_pymupdf
from .chunking import plan_windows
from .conversion import MarkItDownConversion, markitdown_mode, route_document
from .extractors import pdf_pages_requiring_ocr
from .markitdown_isolated import convert_with_markitdown_isolated
from .models import DocumentPlan, SourceBlock
from .ocr import GeminiFlashLiteOcrAdapter
from .structure import detect_structure


def _language_distribution(blocks: list[SourceBlock]) -> dict[str, float]:
    text = "".join(block.text for block in blocks)
    if not text:
        return {}
    cjk = len(re.findall(r"[㐀-鿿豈-﫿]", text))
    letters = len(re.findall(r"[A-Za-z]", text))
    denominator = max(1, cjk + letters)
    distribution: dict[str, float] = {}
    if cjk:
        distribution["zh"] = round(cjk / denominator, 4)
    if letters:
        distribution["en_or_latin"] = round(letters / denominator, 4)
    return distribution


def _build_plan(
    path: Path,
    *,
    ocr_adapter: GeminiFlashLiteOcrAdapter | None = None,
    markitdown_converter: Callable[[Path], MarkItDownConversion] | None = None,
) -> DocumentPlan:
    routed = route_document(path, ocr_adapter=ocr_adapter, markitdown_converter=markitdown_converter)
    blocks = routed.blocks
    manifest = routed.manifest
    title = routed.title
    structure = detect_structure(title, blocks)
    windows = plan_windows(blocks, structure)
    summary = next((block.text for block in blocks if block.text.strip()), title)[:500]
    return DocumentPlan(
        title=title,
        summary=summary,
        markdown=routed.markdown,
        manifest=manifest,
        blocks=blocks,
        structure=structure,
        windows=windows,
        languageDistribution=_language_distribution(blocks),
    )


def extract_and_plan_document(path: Path) -> DocumentPlan:
    """Deterministic/non-model entrypoint retained for tests and OCR-off tooling."""
    return _build_plan(path)


def _replay(result: MarkItDownConversion | None, error: BaseException | None) -> Callable[[Path], MarkItDownConversion]:
    """Hand route_document a MarkItDown result that was produced in a child process."""
    def converter(_path: Path) -> MarkItDownConversion:
        if error is not None:
            raise error
        assert result is not None
        return result
    return converter


async def extract_and_plan_document_with_gemini(
    path: Path,
    *,
    client: object,
    model: str,
    ocr_mode: str | None = None,
    cache_root: Path | None = None,
) -> DocumentPlan:
    """Run policy-controlled Gemini Flash Lite OCR, then deterministic locator planning.

    MarkItDown runs in a child process from the start, alongside OCR. All PyMuPDF
    work runs on the single PyMuPDF thread. A MarkItDown failure or timeout does not
    fail the source: route_document keeps the native Markdown and records a
    markitdown_fallback warning.
    """
    markitdown_task: asyncio.Task[MarkItDownConversion] | None = None
    if markitdown_mode() != "off":
        markitdown_task = asyncio.create_task(convert_with_markitdown_isolated(path))
    try:
        adapter: GeminiFlashLiteOcrAdapter | None = None
        if path.suffix.lower() == ".pdf":
            adapter = GeminiFlashLiteOcrAdapter(
                client=client,
                model=model,
                mode=ocr_mode,
                cache_root=cache_root,
            )
            targets = await run_pymupdf(pdf_pages_requiring_ocr, path, mode=adapter.mode)
            if targets:
                await adapter.prepare_pdf(path, targets)

        converter: Callable[[Path], MarkItDownConversion] | None = None
        if markitdown_task is not None:
            try:
                converter = _replay(await markitdown_task, None)
            except Exception as exc:  # timeout or worker failure: route_document falls back
                converter = _replay(None, exc)
        # The adapter only serves OCR results that prepare_pdf already fetched, and the
        # MarkItDown result is already in memory, so this step is native extraction only.
        return await run_pymupdf(_build_plan, path, ocr_adapter=adapter, markitdown_converter=converter)
    finally:
        if markitdown_task is not None and not markitdown_task.done():
            markitdown_task.cancel()  # kills the child process
