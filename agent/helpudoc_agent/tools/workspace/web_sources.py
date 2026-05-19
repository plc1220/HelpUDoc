"""Structured web search / URL context tools backed by Gemini."""
from __future__ import annotations

import json
from typing import Any, Dict, List

from langchain_core.messages import HumanMessage
from pydantic import ValidationError
from langchain_core.tools import Tool, tool
from langchain_google_genai import ChatGoogleGenerativeAI

from ...state import WorkspaceState
from ...utils import SourceTracker, extract_web_url
from .policy import apply_search_policy_guard
from .schemas import StructuredWebAnswer
from .timeouts import DEFAULT_SEARCH_TIMEOUT, invoke_lc_with_timeout


def sources_from_grounding_dict(grounding: dict) -> List[Dict[str, str]]:
    sources: List[Dict[str, str]] = []
    seen: set[str] = set()
    for chunk in grounding.get("groundingChunks") or []:
        if not isinstance(chunk, dict):
            continue
        web = chunk.get("web")
        if not isinstance(web, dict):
            continue
        actual_url = extract_web_url(web)
        if not actual_url or actual_url in seen:
            continue
        title_raw = web.get("title")
        title = str(title_raw).strip() if title_raw else "Untitled"
        sources.append({"title": title or "Untitled", "url": actual_url})
        seen.add(actual_url)
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
            if url:
                url = extract_web_url({"uri": url, "resolvedUri": None, "displayUri": None}) or url
            if not url:
                extras = ann.get("extras")
                if isinstance(extras, dict):
                    meta = extras.get("google_ai_metadata")
                    if isinstance(meta, dict):
                        nested = meta.get("web_url") or meta.get("url")
                        if isinstance(nested, str) and nested.strip():
                            cand = nested.strip()
                            url = extract_web_url({"uri": cand, "resolvedUri": None, "displayUri": None}) or cand
            if not url:
                continue
            if url in seen:
                continue
            title_raw = ann.get("title")
            title = str(title_raw).strip() if title_raw else "Untitled"
            sources.append({"title": title or "Untitled", "url": url})
            seen.add(url)
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
            f"Return JSON with a factual summary (field summary) and up to {max_results} "
            f"distinct sources each with url and optional title."
        )
        llm_search = llm.bind(
            tools=[{"google_search": {}}],
            response_mime_type="application/json",
            response_schema=StructuredWebAnswer.model_json_schema(),
        )
        response, error = invoke_lc_with_timeout(
            lambda: llm_search.invoke([HumanMessage(content=search_prompt)], temperature=0),
            timeout_s=DEFAULT_SEARCH_TIMEOUT,
            label=search_label,
        )
        if error or response is None:
            return f"Search failed ({error or 'unknown error'})."

        summary, sources = parse_structured_web_answer(response)
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

        summary, sources = parse_structured_web_answer(response)
        if sources:
            tracker.record(workspace_state, sources)
        return summary + _format_sources_block(sources, empty_message="No URL sources returned.")
