"""Tagged files, RAG prefetch hints, and dashboard guidance for chat turns."""
from __future__ import annotations

import html as html_lib
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Sequence, Set

from .constants import (
    _RAG_PREFETCHABLE_EXTENSIONS,
    _TAGGED_DATASET_EXTENSIONS,
    _TAGGED_HTML_EXTENSIONS,
    _TAGGED_RAG_CONTEXT_CHAR_BUDGET,
    _STRICT_DASHBOARD_CHART_BUDGET,
    _STRICT_DASHBOARD_PREVIEW_BUDGET,
    _STRICT_DASHBOARD_QUERY_BUDGET,
    _STRICT_DASHBOARD_SCHEMA_BUDGET,
)

logger = logging.getLogger(__name__)


def _filter_rag_prefetchable_tagged_files(tagged_paths: Sequence[str]) -> List[str]:
    candidates: List[str] = []
    for raw in tagged_paths:
        if not isinstance(raw, str):
            continue
        cleaned = raw.strip()
        if not cleaned:
            continue
        suffix = Path(cleaned).suffix.lower()
        if suffix in _RAG_PREFETCHABLE_EXTENSIONS:
            candidates.append(cleaned)
    return candidates


def _filter_tagged_dataset_files(tagged_paths: Sequence[str]) -> List[str]:
    candidates: List[str] = []
    for raw in tagged_paths:
        if not isinstance(raw, str):
            continue
        cleaned = raw.strip()
        if not cleaned:
            continue
        suffix = Path(cleaned).suffix.lower()
        if suffix in _TAGGED_DATASET_EXTENSIONS:
            candidates.append(cleaned)
    return candidates


def _extract_tagged_files_from_text(content: str) -> List[str]:
    if not content:
        return []
    lines = content.splitlines()
    tagged: List[str] = []
    in_block = False
    for line in lines:
        stripped = line.strip()
        if not stripped:
            if in_block:
                break
            continue
        if stripped.startswith("Tagged files"):
            in_block = True
            continue
        if in_block:
            if stripped.startswith("-"):
                candidate = stripped.lstrip("-").strip()
                if candidate:
                    tagged.append(candidate)
            else:
                break
    return tagged


def _normalize_tagged_file_paths(tagged_paths: Sequence[str]) -> List[str]:
    normalized: List[str] = []
    for raw in tagged_paths:
        if not isinstance(raw, str):
            continue
        cleaned = raw.strip().replace("\\", "/")
        if not cleaned:
            continue
        if not cleaned.startswith("/"):
            cleaned = f"/{cleaned.lstrip('/')}"
        normalized.append(cleaned)
    return sorted(set(normalized))


def _allow_basename_match_for_path(path_value: str) -> bool:
    normalized = str(path_value or "").strip().replace("\\", "/").lstrip("/")
    if not normalized:
        return False
    if normalized.startswith(".system/"):
        return False
    return "/" not in normalized


def _build_tagged_rag_keywords(prompt: str, tagged_paths: Sequence[str]) -> List[str]:
    keywords: List[str] = []
    if isinstance(prompt, str) and prompt.strip():
        keywords.append(prompt.strip())
    for item in _normalize_tagged_file_paths(tagged_paths):
        keywords.append(item)
        name = Path(item).name
        if name:
            keywords.append(name)
    deduped: List[str] = []
    seen: Set[str] = set()
    for item in keywords:
        if item not in seen:
            seen.add(item)
            deduped.append(item)
    return deduped


def _filter_rag_chunks_to_tagged_paths(chunks: Sequence[Dict[str, Any]], tagged_paths: Sequence[str]) -> List[Dict[str, Any]]:
    normalized = _normalize_tagged_file_paths(tagged_paths)
    if not normalized:
        return list(chunks)
    basenames = {Path(item).name for item in normalized if _allow_basename_match_for_path(item)}
    filtered: List[Dict[str, Any]] = []
    for chunk in chunks:
        file_path = str(chunk.get("file_path") or "").strip().replace("\\", "/")
        if file_path and not file_path.startswith("/"):
            file_path = f"/{file_path.lstrip('/')}"
        if file_path in normalized or Path(file_path).name in basenames:
            filtered.append(chunk)
    return filtered


def _compress_tagged_context_lines(lines: Sequence[str], *, max_chars: int = _TAGGED_RAG_CONTEXT_CHAR_BUDGET) -> str | None:
    collected: List[str] = []
    total = 0
    for raw in lines:
        content = str(raw or "").strip()
        if not content:
            continue
        piece = content if not collected else f"\n\n{content}"
        if total + len(piece) > max_chars:
            remaining = max_chars - total
            if remaining > 64:
                collected.append(piece[:remaining].rstrip() + "\n\n[Truncated]")
            break
        collected.append(piece if not collected else content)
        total += len(piece)
    if not collected:
        return None
    return "\n\n".join(collected)[:max_chars]


def _strip_html_fragment(fragment: str) -> str:
    text = re.sub(r"(?is)<[^>]+>", " ", fragment or "")
    text = html_lib.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _extract_html_outline_from_path(path: Path, *, max_chars: int = _TAGGED_RAG_CONTEXT_CHAR_BUDGET) -> str | None:
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        logger.exception("Failed reading tagged HTML outline: %s", path)
        return None
    sanitized = re.sub(r"(?is)<script\b[^>]*>.*?</script>", " ", raw)
    sanitized = re.sub(r"(?is)<style\b[^>]*>.*?</style>", " ", sanitized)
    sanitized = re.sub(r"(?is)<!--.*?-->", " ", sanitized)

    outline_parts: List[str] = []
    title_match = re.search(r"(?is)<title[^>]*>(.*?)</title>", sanitized)
    title_text = _strip_html_fragment(title_match.group(1)) if title_match else ""
    if title_text:
        outline_parts.append(f"TITLE: {title_text}")

    headings = [
        _strip_html_fragment(match)
        for match in re.findall(r"(?is)<h[1-3][^>]*>(.*?)</h[1-3]>", sanitized)
    ]
    headings = [item for item in headings if item]
    if headings:
        outline_parts.append("HEADINGS:")
        outline_parts.extend(f"- {item}" for item in headings[:12])

    paragraphs = [
        _strip_html_fragment(match)
        for match in re.findall(r"(?is)<p[^>]*>(.*?)</p>", sanitized)
    ]
    paragraphs = [item for item in paragraphs if item]
    if paragraphs:
        outline_parts.append("EXCERPTS:")
        outline_parts.extend(paragraphs[:8])

    if not outline_parts:
        fallback_text = _strip_html_fragment(sanitized)
        if fallback_text:
            outline_parts.append(fallback_text)

    return _compress_tagged_context_lines(outline_parts, max_chars=max_chars)


def _append_tagged_file_guidance(prompt: str, tagged_paths: Sequence[str]) -> str:
    if not prompt:
        return prompt
    if "Tagged file guidance:" in prompt:
        return prompt
    has_html = any(
        isinstance(raw, str) and Path(raw.strip()).suffix.lower() in _TAGGED_HTML_EXTENSIONS
        for raw in tagged_paths
    )
    if not has_html:
        return prompt
    guidance = (
        "Tagged file guidance:\n"
        "- Treat tagged .html files as reference artifacts, not raw context to ingest in full.\n"
        "- Do not read an entire report HTML unless absolutely necessary.\n"
        "- Prefer the canonical dataset as the source of truth and inspect only targeted report sections if needed."
    )
    return f"{prompt.rstrip()}\n\n{guidance}"


def _append_artifact_first_guidance(
    prompt: str,
    file_context_refs: Sequence[Dict[str, Any]],
    tagged_paths: Sequence[str],
    *,
    multimodal_active: bool,
) -> str:
    if not prompt:
        return prompt
    if "Artifact-first guidance:" in prompt:
        return prompt
    if not file_context_refs:
        return prompt
    ready_refs = [
        item
        for item in file_context_refs
        if str(item.get("status") or "").strip().lower() in {"ready", "partial"}
    ]
    if not ready_refs:
        return prompt
    binary_ready = [
        item
        for item in ready_refs
        if not str(item.get("sourceMimeType") or "").strip().lower().startswith("text/")
    ]
    if not binary_ready:
        return prompt
    guidance_lines = [
        "Artifact-first guidance:",
        "- Ready derived artifacts are available for the attached files and are the primary source of truth for this turn.",
        "- Prefer the tagged derived artifact paths over the original source file when answering.",
        "- Do not call read_file on the original binary source (.docx, .pptx, .pdf, etc.) if a ready derived artifact is already available.",
    ]
    if multimodal_active:
        guidance_lines.append(
            "- Use the current-turn multimodal attachment only for additional grounding; keep follow-up reasoning anchored to the derived artifact."
        )
    else:
        guidance_lines.append(
            "- If you need to inspect content, read the derived artifact markdown first rather than the original binary file."
        )
    if tagged_paths:
        guidance_lines.append("- Tagged derived artifacts:")
        guidance_lines.extend(f"  - {path}" for path in tagged_paths)
    return f"{prompt.rstrip()}\n\n" + "\n".join(guidance_lines)


def _build_dashboard_mode_context(
    context: Dict[str, Any],
    tagged_paths: Sequence[str],
) -> Dict[str, Any] | None:
    if str(context.get("active_skill") or "").strip() != "data/dashboard":
        return None
    dataset_paths = _filter_tagged_dataset_files(tagged_paths)
    return {
        "strictLocalDatasets": bool(dataset_paths),
        "taggedDatasetPaths": dataset_paths,
        "queryBudget": _STRICT_DASHBOARD_QUERY_BUDGET,
        "preApprovalPreviewBudget": _STRICT_DASHBOARD_PREVIEW_BUDGET,
        "schemaBudget": _STRICT_DASHBOARD_SCHEMA_BUDGET,
        "chartBudget": _STRICT_DASHBOARD_CHART_BUDGET,
    }


def _build_dashboard_runtime_guidance(user_request: str) -> str:
    tagged_paths = _extract_tagged_files_from_text(user_request)
    dataset_paths = _filter_tagged_dataset_files(tagged_paths)
    guidance_lines = [
        "Dashboard runtime guidance:",
        "- This skill is low-variance and review-first.",
        "- Before request_plan_approval: inspect schema once and use at most one lightweight preview query only if needed.",
        "- Before approval, do not run aggregate analysis, do not generate charts, and do not materialize new warehouse datasets.",
        "- After approval, use one bounded prep bundle for KPI summary, time trend, top geography breakdowns, top device/browser breakdowns, top category drivers, and an optional driver table.",
        "- Reuse aggregate outputs instead of re-querying the same dimension repeatedly.",
        "- Do not run duplicate country, device, browser, or category passes unless the approved plan explicitly requires a distinct visual.",
        "- Generate 3 to 5 approved charts only, then call generate_dashboard exactly once.",
        "- If the dataset cannot support the approved visuals, stop with a clear insufficiency message instead of ending with charts only.",
    ]
    if dataset_paths:
        guidance_lines.insert(
            1,
            "- Tagged local dataset(s): "
            + ", ".join(dataset_paths)
            + ". Use these as the source of truth and do not rediscover upstream tables.",
        )
    return "\n".join(guidance_lines)
