"""Universal document conversion facade with provenance-preserving sidecars.

MarkItDown owns format recognition and Markdown normalization. Native adapters
remain authoritative for source locations where a Markdown-only result would
discard page, paragraph, table, and bounding-box evidence.
"""
from __future__ import annotations

import importlib.metadata
import mimetypes
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .extractors import extract_blocks
from .models import ExtractionManifest, ExtractionWarning, SourceBlock
from .ocr import OcrAdapter


MARKITDOWN_MODES = {"off", "shadow", "fallback", "primary"}
NATIVE_PROVENANCE_SUFFIXES = {
    ".csv", ".docx", ".htm", ".html", ".json", ".md", ".pdf", ".tsv", ".txt",
}


@dataclass(frozen=True)
class MarkItDownConversion:
    markdown: str
    title: str | None
    converter: str


@dataclass(frozen=True)
class RoutedDocument:
    title: str
    markdown: str
    blocks: list[SourceBlock]
    manifest: ExtractionManifest


def render_blocks_markdown(title: str, blocks: list[SourceBlock]) -> str:
    lines = [f"# {title}"]
    current_page: int | None = None
    current_unit: tuple[str, int] | None = None
    for block in blocks:
        if block.page is not None and block.page != current_page:
            current_page = block.page
            lines.extend(["", f"## Page {current_page}"])
        elif block.unit is not None and block.unitType:
            unit = (block.unitType, block.unit)
            if unit != current_unit:
                current_unit = unit
                lines.extend(["", f"## {block.unitType.title()} {block.unit}"])
        if block.blockType == "heading":
            level = max(2, min(6, (block.headingLevel or 1) + 1))
            lines.extend(["", f"{'#' * level} {block.text}"])
        elif block.blockType == "table":
            lines.extend(["", block.text])
        else:
            lines.extend(["", block.text])
    return "\n".join(lines).strip()


def _markitdown_version() -> str:
    try:
        return importlib.metadata.version("markitdown")
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def _convert_with_markitdown(path: Path) -> MarkItDownConversion:
    """Convert only a local file so uploaded content cannot trigger URL fetching."""
    from markitdown import MarkItDown  # type: ignore

    result = MarkItDown(enable_plugins=False).convert_local(path)
    markdown = str(getattr(result, "markdown", None) or getattr(result, "text_content", "") or "").strip()
    title = getattr(result, "title", None)
    return MarkItDownConversion(
        markdown=markdown,
        title=str(title).strip() if title else None,
        converter=f"markitdown/{_markitdown_version()}",
    )


def _content_hash(text: str) -> str:
    import hashlib

    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _generic_markdown_blocks(markdown: str, suffix: str) -> tuple[list[SourceBlock], int]:
    """Create addressable coarse blocks when no native locator adapter exists."""
    blocks: list[SourceBlock] = []
    current_unit = 1
    unit_type = "slide" if suffix == ".pptx" else "sheet" if suffix in {".xls", ".xlsx", ".xlsm"} else "section"
    seen_units = {current_unit}
    pending: list[str] = []
    pending_type = "paragraph"

    def emit(text: str, block_type: str, heading_level: int | None = None) -> None:
        block_text = text.strip()
        if not block_text:
            return
        blocks.append(SourceBlock(
            id=f"markitdown-b{len(blocks) + 1}",
            ordinal=len(blocks),
            text=block_text,
            blockType=block_type,  # type: ignore[arg-type]
            paragraph=len(blocks) + 1,
            unit=current_unit,
            unitType=unit_type,
            headingLevel=heading_level,
            extractionMethod="fallback",
            extractionConfidence=0.8,
            contentHash=_content_hash(block_text),
        ))

    def flush() -> None:
        nonlocal pending
        if pending:
            emit("\n".join(pending), pending_type)
            pending = []

    for line in markdown.splitlines():
        stripped = line.strip()
        slide = re.fullmatch(r"<!--\s*Slide\s+(?:number\s*:\s*)?(\d+)\s*-->", stripped, re.IGNORECASE)
        if slide:
            flush()
            current_unit = int(slide.group(1))
            seen_units.add(current_unit)
            continue
        heading = re.fullmatch(r"(#{1,6})\s+(.+)", stripped)
        if heading:
            flush()
            if suffix in {".xls", ".xlsx", ".xlsm"} and len(heading.group(1)) <= 2 and blocks:
                current_unit += 1
                seen_units.add(current_unit)
            emit(heading.group(2), "heading", len(heading.group(1)))
            continue
        is_table = stripped.startswith("|") and stripped.endswith("|")
        if is_table and pending_type != "table":
            flush()
            pending_type = "table"
        elif not is_table and pending_type == "table":
            flush()
            pending_type = "paragraph"
        if not stripped:
            flush()
            pending_type = "paragraph"
            continue
        pending.append(line.rstrip())
    flush()
    return blocks, len(seen_units) if blocks else 0


def route_document(
    path: Path,
    *,
    ocr_adapter: OcrAdapter | None = None,
    mode: str | None = None,
    markitdown_converter: Callable[[Path], MarkItDownConversion] | None = None,
) -> RoutedDocument:
    """Route one local document and return Markdown plus locator-aware blocks."""
    selected_mode = str(mode or os.environ.get("KNOWLEDGE_MARKITDOWN_MODE", "primary")).strip().lower()
    if selected_mode not in MARKITDOWN_MODES:
        raise ValueError(f"Invalid KNOWLEDGE_MARKITDOWN_MODE {selected_mode!r}")

    suffix = path.suffix.lower()
    title = path.name
    native_markdown = ""
    blocks: list[SourceBlock] = []
    manifest: ExtractionManifest | None = None
    if suffix in NATIVE_PROVENANCE_SUFFIXES:
        blocks, manifest = extract_blocks(path, ocr_adapter=ocr_adapter)
        native_markdown = render_blocks_markdown(title, blocks)
        manifest.converter = f"helpudoc-native/{manifest.sourceType}"
        manifest.locatorStrategy = "native-sidecar"
        manifest.mediaType = mimetypes.guess_type(path.name, strict=False)[0]

    converted: MarkItDownConversion | None = None
    conversion_error: str | None = None
    if selected_mode != "off":
        try:
            converted = (markitdown_converter or _convert_with_markitdown)(path)
            if not converted.markdown:
                conversion_error = "MarkItDown returned empty Markdown."
                converted = None
        except Exception as exc:  # MarkItDown reports converter/dependency failures by exception.
            conversion_error = f"{type(exc).__name__}: {exc}"

    if manifest is None:
        if converted is None:
            details = f" ({conversion_error})" if conversion_error else ""
            raise ValueError(f"Unsupported Knowledge source {suffix or '[none]'}{details}")
        blocks, discovered = _generic_markdown_blocks(converted.markdown, suffix)
        if not blocks:
            raise ValueError("MarkItDown produced no addressable document content")
        manifest = ExtractionManifest(
            extractorVersion="helpudoc-extractor/3",
            sourceType=suffix.lstrip(".") or "document",
            discoveredSourceUnits=discovered,
            processedSourceUnits=discovered,
            failedSourceUnits=0,
            converter=converted.converter,
            markdownConverter=converted.converter,
            locatorStrategy="markdown-structural",
            mediaType=mimetypes.guess_type(path.name, strict=False)[0],
        )
        native_markdown = render_blocks_markdown(title, blocks)
    elif converted is not None:
        manifest.markdownConverter = converted.converter

    if conversion_error and manifest is not None:
        manifest.warnings.append(ExtractionWarning(
            sourceUnit="document",
            code="markitdown_fallback",
            message=f"Native extraction was retained because {conversion_error}",
        ))

    if selected_mode == "primary" and converted is not None:
        markdown = converted.markdown
    elif selected_mode == "fallback" and not native_markdown and converted is not None:
        markdown = converted.markdown
    else:
        markdown = native_markdown or (converted.markdown if converted else "")

    return RoutedDocument(
        title=converted.title or title if converted else title,
        markdown=markdown,
        blocks=blocks,
        manifest=manifest,
    )
