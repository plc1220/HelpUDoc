"""Extraction-to-window pipeline used by the internal Knowledge API."""
from __future__ import annotations

import re
from pathlib import Path

from .chunking import plan_windows
from .conversion import route_document
from .extractors import pdf_pages_requiring_ocr
from .models import DocumentPlan, SourceBlock
from .ocr import GeminiFlashLiteOcrAdapter
from .structure import detect_structure


def _language_distribution(blocks: list[SourceBlock]) -> dict[str, float]:
    text = "".join(block.text for block in blocks)
    if not text:
        return {}
    cjk = len(re.findall(r"[\u3400-\u9fff\uf900-\ufaff]", text))
    letters = len(re.findall(r"[A-Za-z]", text))
    denominator = max(1, cjk + letters)
    distribution: dict[str, float] = {}
    if cjk:
        distribution["zh"] = round(cjk / denominator, 4)
    if letters:
        distribution["en_or_latin"] = round(letters / denominator, 4)
    return distribution


def _build_plan(path: Path, *, ocr_adapter: GeminiFlashLiteOcrAdapter | None = None) -> DocumentPlan:
    routed = route_document(path, ocr_adapter=ocr_adapter)
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


async def extract_and_plan_document_with_gemini(
    path: Path,
    *,
    client: object,
    model: str,
    ocr_mode: str | None = None,
    cache_root: Path | None = None,
) -> DocumentPlan:
    """Run policy-controlled Gemini Flash Lite OCR, then deterministic locator planning."""
    adapter: GeminiFlashLiteOcrAdapter | None = None
    if path.suffix.lower() == ".pdf":
        adapter = GeminiFlashLiteOcrAdapter(
            client=client,
            model=model,
            mode=ocr_mode,
            cache_root=cache_root,
        )
        targets = pdf_pages_requiring_ocr(path, mode=adapter.mode)
        if targets:
            await adapter.prepare_pdf(path, targets)
    return _build_plan(path, ocr_adapter=adapter)
