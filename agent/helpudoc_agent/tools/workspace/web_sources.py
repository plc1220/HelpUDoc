"""Structured web search / URL context tools backed by Gemini."""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, List

from langchain_core.messages import HumanMessage
from pydantic import ValidationError
from langchain_core.tools import Tool, tool
from langchain_google_genai import ChatGoogleGenerativeAI

from ...state import WorkspaceState
from ...utils import SourceTracker, extract_web_url, resolve_vertex_redirects
from .policy import apply_search_policy_guard, record_search_success
from .schemas import StructuredWebAnswer
from .timeouts import (
    DEFAULT_SEARCH_MAX_ATTEMPTS,
    DEFAULT_SEARCH_MAX_CONSECUTIVE_FAILURES,
    DEFAULT_SEARCH_TIMEOUT,
    invoke_lc_with_timeout,
    search_retry_delay,
)

logger = logging.getLogger(__name__)

_TRANSIENT_SEARCH_MARKERS = (
    "timeout",
    "deadline",
    "429",
    "resource_exhausted",
    "500",
    "502",
    "503",
    "504",
    "internal error",
    "service unavailable",
    "temporarily unavailable",
    "unavailable",
    "no grounded sources",
)


# A wrong model name, region or IAM binding fails every call identically and no
# amount of retrying helps. These used to fall through to the generic SEARCH_FAILED
# envelope, so an operator error reached the user as "live web research is
# unavailable" and was logged at no level at all.
_CONFIG_FAULT_MARKERS = (
    "404",
    "not_found",
    "was not found",
    "403",
    "permission_denied",
    "permission denied",
    "unauthorized",
    "unauthenticated",
)


def _is_transient_search_error(error_text: str) -> bool:
    normalized = str(error_text or "").strip().lower()
    if _is_config_fault(normalized):
        return False
    return any(marker in normalized for marker in _TRANSIENT_SEARCH_MARKERS)


def _is_config_fault(error_text: str) -> bool:
    normalized = str(error_text or "").strip().lower()
    return any(marker in normalized for marker in _CONFIG_FAULT_MARKERS)


def _response_diagnostics(response: Any) -> dict:
    """Why a grounded search came back empty.

    None of this was recorded before, so a zero-source result was indistinguishable
    from the model simply choosing not to ground. `finish_reason` separates the two:
    MAX_TOKENS means the output budget was spent (thinking tokens count against it)
    before grounding metadata was attached.
    """
    metadata = getattr(response, "response_metadata", None) or {}
    usage = getattr(response, "usage_metadata", None) or {}
    grounding = metadata.get("grounding_metadata") or {} if isinstance(metadata, dict) else {}
    chunk_count = 0
    if isinstance(grounding, dict):
        chunks = grounding.get("groundingChunks") or grounding.get("grounding_chunks") or []
        chunk_count = len(chunks) if isinstance(chunks, list) else 0
    return {
        "finish_reason": metadata.get("finish_reason") if isinstance(metadata, dict) else None,
        "output_tokens": usage.get("output_tokens") if isinstance(usage, dict) else None,
        "input_tokens": usage.get("input_tokens") if isinstance(usage, dict) else None,
        "grounding_chunks": chunk_count,
    }


def _search_error_code(error_text: str) -> str:
    normalized = str(error_text or "").strip().lower()
    if _is_config_fault(normalized):
        return "SEARCH_CONFIG_ERROR"
    if "timeout" in normalized or "deadline" in normalized:
        return "SEARCH_TIMEOUT"
    if "no grounded sources" in normalized:
        return "SEARCH_NO_SOURCES"
    if _is_transient_search_error(normalized):
        return "SEARCH_TRANSIENT_ERROR"
    return "SEARCH_FAILED"


def _search_error_envelope(
    *,
    error_text: str,
    attempts: int,
    retryable: bool,
) -> str:
    safe_error = str(error_text or "unknown error")[:300]
    if retryable:
        next_call = "google_search: retry once with a narrower query"
        message = f"Google Search failed after {attempts} attempt(s): {safe_error}."
    else:
        next_call = "none: report that live web research is unavailable for this run"
        message = (
            f"Google Search is unavailable after {attempts} attempt(s): {safe_error}. "
            "Do not claim a sourced research result without successfully retrieved sources."
        )
    return json.dumps(
        {
            "status": "error",
            "tool": "google_search",
            "errorCode": _search_error_code(error_text),
            "message": message,
            "retryable": retryable,
            "attempts": attempts,
            "timeoutSeconds": DEFAULT_SEARCH_TIMEOUT,
            "suggestedNextCall": next_call,
        }
    )


def sources_from_grounding_dict(grounding: dict) -> List[Dict[str, str]]:
    """Collect citation sources with raw URLs. Redirects are resolved by the caller."""
    sources: List[Dict[str, str]] = []
    seen: set[str] = set()
    for chunk in grounding.get("groundingChunks") or grounding.get("grounding_chunks") or []:
        if not isinstance(chunk, dict):
            continue
        web = chunk.get("web")
        if not isinstance(web, dict):
            continue
        raw_url = extract_web_url(web)
        # Deduplicate on the raw URL. Deduplicating after resolution meant every
        # repeated citation chunk paid for its own round trip before being dropped.
        if not raw_url or raw_url in seen:
            continue
        title_raw = web.get("title")
        title = str(title_raw).strip() if title_raw else "Untitled"
        sources.append({"title": title or "Untitled", "url": raw_url})
        seen.add(raw_url)
    return sources


def sources_from_citation_annotations(ai_message: Any) -> List[Dict[str, str]]:
    """Extract URLs from LangChain Google GenAI text block citation annotations."""
    blocks = getattr(ai_message, "content_blocks", None)
    if not isinstance(blocks, list):
        content = getattr(ai_message, "content", None)
        blocks = content if isinstance(content, list) else []

    sources: List[Dict[str, str]] = []
    seen: set[str] = set()
    for block in blocks:
        if not isinstance(block, dict):
            continue
        annotations = block.get("annotations")
        if not isinstance(annotations, list):
            continue
        for ann in annotations:
            if not isinstance(ann, dict):
                continue
            if str(ann.get("type") or "").strip().lower() != "citation":
                continue
            url_raw = ann.get("url") or ann.get("uri")
            url: str | None = url_raw.strip() if isinstance(url_raw, str) and url_raw.strip() else None
            if not url:
                extras = ann.get("extras")
                if isinstance(extras, dict):
                    meta = extras.get("google_ai_metadata")
                    if isinstance(meta, dict):
                        nested = meta.get("web_url") or meta.get("url")
                        if isinstance(nested, str) and nested.strip():
                            url = nested.strip()
            if not url:
                continue
            if url in seen:
                continue
            title_raw = ann.get("title")
            title = str(title_raw).strip() if title_raw else "Untitled"
            sources.append({"title": title or "Untitled", "url": url})
            seen.add(url)
    return sources


def verified_google_search_sources(ai_message: Any) -> List[Dict[str, str]]:
    """Return only URLs emitted by Gemini's grounding/citation metadata.

    Citation URLs arrive as Vertex redirect links. They are gathered raw, deduplicated,
    then resolved in one bounded concurrent batch — resolving them one at a time as they
    were extracted accounted for ~90% of this tool's wall clock.
    """
    metadata = getattr(ai_message, "response_metadata", None) or {}
    grounding = (metadata.get("grounding_metadata") or {}) if isinstance(metadata, dict) else {}
    candidates = sources_from_grounding_dict(grounding) + sources_from_citation_annotations(ai_message)

    resolved_map = resolve_vertex_redirects(
        str(item.get("url") or "").strip() for item in candidates
    )

    sources: List[Dict[str, str]] = []
    seen: set[str] = set()
    for item in candidates:
        raw_url = str(item.get("url") or "").strip()
        if not raw_url:
            continue
        # Unresolved redirects map to themselves and are still usable links.
        url = resolved_map.get(raw_url, raw_url)
        if url in seen:
            continue
        seen.add(url)
        sources.append({"title": item.get("title") or "Untitled", "url": url})
    return sources


def parse_structured_web_answer(ai_message: Any) -> tuple[str, List[Dict[str, str]]]:
    md = getattr(ai_message, "response_metadata", None) or {}
    grounding_sources = sources_from_grounding_dict(
        (md.get("grounding_metadata") or {}) if isinstance(md, dict) else {}
    )
    citation_sources = sources_from_citation_annotations(ai_message)

    raw = getattr(ai_message, "text", None) or ""
    summary = ""
    sources: List[Dict[str, str]] = []

    if isinstance(raw, str) and raw.strip():
        try:
            data = json.loads(raw.strip())
        except json.JSONDecodeError:
            data = None
        if isinstance(data, dict):
            try:
                parsed = StructuredWebAnswer.model_validate(data)
                summary = (parsed.summary or "").strip()
                sources = [
                    {"title": (s.title or "Untitled").strip() or "Untitled", "url": s.url.strip()}
                    for s in parsed.sources
                    if (s.url or "").strip()
                ]
            except ValidationError:
                summary = str(data.get("summary") or "").strip()
                for item in data.get("sources") or []:
                    if not isinstance(item, dict):
                        continue
                    url = str(item.get("url") or "").strip()
                    if not url:
                        continue
                    title = str(item.get("title") or "Untitled").strip() or "Untitled"
                    sources.append({"title": title, "url": url})
        elif data is None:
            summary = raw.strip()

    if not summary:
        summary = (raw.strip() if isinstance(raw, str) else "") or "No results found."

    if not sources and grounding_sources:
        sources = list(grounding_sources)
    if not sources and citation_sources:
        sources = list(citation_sources)

    seen: set[str] = set()
    deduped: List[Dict[str, str]] = []
    for item in sources:
        url = item.get("url")
        if not url or url in seen:
            continue
        seen.add(url)
        deduped.append({"title": item.get("title") or "Untitled", "url": url})

    return summary, deduped


def _format_sources_block(
    sources: List[Dict[str, str]],
    *,
    max_results: int | None = None,
    empty_message: str = "No sources were found for this query.",
) -> str:
    if not sources:
        return f"\n\n--- SOURCES ---\n{empty_message}"
    items = sources[:max_results] if max_results else sources
    lines = [f"\nTitle: {src['title']}\nURL: {src['url']}" for src in items]
    return "\n\n--- SOURCES ---\n" + "\n".join(lines)


def build_google_search_tool(
    workspace_state: WorkspaceState,
    source_tracker: SourceTracker,
    llm: ChatGoogleGenerativeAI | None = None,
    *,
    tool_name: str = "google_search",
    tool_description: str = "Use Gemini's built-in search to gather fresh information.",
    search_label: str = "google_search",
) -> Tool:
    """Public builder so YAML entrypoints stay accurate."""
    if llm is None:
        raise ValueError("ChatGoogleGenerativeAI instance is required")
    tracker = source_tracker

    @tool
    def grounded_search(query: str, max_results: int = 5) -> str:
        """Run Gemini Google Search for the given query."""
        blocked = apply_search_policy_guard(workspace_state, tool_name)
        if blocked:
            return blocked

        try:
            max_results = max(1, int(max_results or 1))
        except (TypeError, ValueError):
            max_results = 5
        search_prompt = (
            f"Search the web for information about: {query}\n\n"
            f"Return a concise factual summary grounded in up to {max_results} distinct web sources. "
            "The API grounding metadata is the authoritative source list."
        )
        llm_search = llm.bind(
            tools=[{"google_search": {}}],
        )
        response = None
        summary = ""
        sources: List[Dict[str, str]] = []
        error_text = ""
        attempts = 0
        for attempt in range(1, DEFAULT_SEARCH_MAX_ATTEMPTS + 1):
            attempts = attempt
            workspace_state.context["google_search_upstream_attempt_count"] = (
                int(workspace_state.context.get("google_search_upstream_attempt_count", 0) or 0) + 1
            )
            response, error = invoke_lc_with_timeout(
                lambda: llm_search.invoke([HumanMessage(content=search_prompt)], temperature=0),
                timeout_s=DEFAULT_SEARCH_TIMEOUT,
                label=f"{search_label} attempt={attempt}",
            )
            if not error and response is not None:
                summary, _ = parse_structured_web_answer(response)
                # Model-authored JSON URLs are not evidence. Only accept sources
                # carried by Gemini's native grounding/citation metadata.
                #
                # Timed separately from the upstream call: this phase runs outside
                # invoke_lc_with_timeout, so a single "completed in Ns" line used to
                # hide the majority of the tool's wall clock.
                parse_started = time.monotonic()
                sources = verified_google_search_sources(response)
                logger.info(
                    "%s attempt=%s citation resolution took %.2fs for %s source(s)",
                    search_label,
                    attempt,
                    time.monotonic() - parse_started,
                    len(sources),
                )
                if sources:
                    workspace_state.context["google_search_consecutive_failures"] = 0
                    workspace_state.context["google_search_success_count"] = (
                        int(workspace_state.context.get("google_search_success_count", 0) or 0) + 1
                    )
                    workspace_state.context["google_search_source_count"] = (
                        int(workspace_state.context.get("google_search_source_count", 0) or 0) + len(sources)
                    )
                    workspace_state.context.pop("google_search_terminal_error", None)
                    # Charge the run budget here, not in the policy guard. Only a call
                    # that produced evidence should cost the run one of its searches.
                    record_search_success(workspace_state, tool_name)
                    break
                diagnostics = _response_diagnostics(response)
                logger.warning(
                    "%s attempt=%s returned no grounded sources (finish_reason=%s "
                    "output_tokens=%s grounding_chunks=%s)",
                    search_label,
                    attempt,
                    diagnostics["finish_reason"],
                    diagnostics["output_tokens"],
                    diagnostics["grounding_chunks"],
                )
                response = None
                error = "no grounded sources returned"

            error_text = str(error or "unknown error")
            failures = int(workspace_state.context.get("google_search_consecutive_failures", 0) or 0) + 1
            workspace_state.context["google_search_consecutive_failures"] = failures
            transient = _is_transient_search_error(error_text)
            terminal = not transient or failures >= DEFAULT_SEARCH_MAX_CONSECUTIVE_FAILURES
            if terminal:
                workspace_state.context["google_search_terminal_error"] = True
                if _is_config_fault(error_text):
                    # Operator-actionable: a bad model name, region or IAM binding
                    # fails every call. Do not let it read as a transient outage.
                    logger.error(
                        "%s disabled for this run by a configuration fault: %s",
                        search_label,
                        error_text[:300],
                    )
                else:
                    logger.warning(
                        "%s circuit opened after %s consecutive failure(s): %s",
                        search_label,
                        failures,
                        error_text[:300],
                    )
                break
            if attempt < DEFAULT_SEARCH_MAX_ATTEMPTS:
                delay = search_retry_delay(attempt)
                logger.warning(
                    "%s transient failure on attempt %s/%s; retrying in %.2fs: %s",
                    search_label,
                    attempt,
                    DEFAULT_SEARCH_MAX_ATTEMPTS,
                    delay,
                    error_text[:200],
                )
                time.sleep(delay)

        if response is None:
            terminal = bool(workspace_state.context.get("google_search_terminal_error"))
            return _search_error_envelope(
                error_text=error_text,
                attempts=attempts,
                retryable=not terminal,
            )

        if sources:
            tracker.record(workspace_state, sources)
        return summary + _format_sources_block(sources, max_results=max_results)

    grounded_search.name = tool_name
    grounded_search.description = tool_description
    return grounded_search


def build_url_context_tool(
    workspace_state: WorkspaceState,
    source_tracker: SourceTracker,
    llm: ChatGoogleGenerativeAI | None = None,
    *,
    tool_name: str = "url_context",
    tool_description: str,
    label: str = "url_context",
) -> Tool:
    if llm is None:
        raise ValueError("ChatGoogleGenerativeAI instance is required")
    tracker = source_tracker

    @tool
    def url_context(urls: List[str], question: str) -> str:
        """Answer using Gemini URL context for explicit URLs."""
        blocked = apply_search_policy_guard(workspace_state, tool_name)
        if blocked:
            return blocked

        normalized: List[str] = []
        for item in urls or []:
            if not isinstance(item, str):
                continue
            stripped = item.strip()
            if stripped.lower().startswith(("http://", "https://")):
                normalized.append(stripped)
        if not normalized:
            return "Provide at least one http:// or https:// URL in urls."

        url_block = "\n".join(f"- {u}" for u in normalized)
        prompt = (
            f"You are answering from these URLs:\n{url_block}\n\nQuestion or instructions:\n{question}\n\n"
            "Return JSON with summary and sources (url plus title when possible), grounded strictly in fetched page content."
        )
        llm_urls = llm.bind(
            tools=[{"url_context": {}}],
            response_mime_type="application/json",
            response_schema=StructuredWebAnswer.model_json_schema(),
        )
        response, error = invoke_lc_with_timeout(
            lambda: llm_urls.invoke([HumanMessage(content=prompt)], temperature=0),
            timeout_s=DEFAULT_SEARCH_TIMEOUT,
            label=label,
        )
        if error or response is None:
            return f"URL context failed ({error or 'unknown error'})."

        # The guard no longer charges on attempt, so record the fetch here. Without
        # this `url_context` stops consuming the pre-plan allowance and a run can
        # gather unlimited evidence before the plan gate.
        record_search_success(workspace_state, tool_name)

        summary, sources = parse_structured_web_answer(response)
        if sources:
            tracker.record(workspace_state, sources)
        return summary + _format_sources_block(sources, empty_message="No URL sources returned.")
