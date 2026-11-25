"""Source extraction for grounded Google GenAI structured web tools."""

from langchain_core.messages import AIMessage

from helpudoc_agent.tools.workspace.web_sources import parse_structured_web_answer


def test_citation_annotation_backfills_when_structured_sources_empty():
    ai = AIMessage(
        content=[
            {
                "type": "text",
                "text": '{"summary": "Done.", "sources": []}',
                "annotations": [
                    {"type": "citation", "title": "Example", "url": "https://example.com/path"},
                ],
            }
        ]
    )
    summary, sources = parse_structured_web_answer(ai)
    assert summary == "Done."
    assert len(sources) == 1
    assert sources[0]["title"] == "Example"
    assert "example.com" in sources[0]["url"]


def test_gemini_url_only_research_counts_native_success_receipts(tmp_path):
    from types import SimpleNamespace
    from unittest.mock import Mock

    from google.genai import types
    from helpudoc_agent.api.routes.chat import _research_source_contract_error
    from helpudoc_agent.state import AgentRuntimeState, WorkspaceState
    from helpudoc_agent.tools.workspace.web_sources import build_url_context_tool
    from helpudoc_agent.utils import SourceTracker

    url = "https://example.org/read"
    failed = "https://example.org/failed"
    summary = '{"summary":"Page evidence","sources":[{"title":"Claim","url":"https://example.org/failed"}]}'
    content = types.Content(parts=[types.Part(text=summary)])
    receipts = types.UrlContextMetadata(url_metadata=[
        types.UrlMetadata(retrieved_url=url, url_retrieval_status="URL_RETRIEVAL_STATUS_SUCCESS"),
        types.UrlMetadata(retrieved_url=failed, url_retrieval_status="URL_RETRIEVAL_STATUS_ERROR"),
    ])
    generate = Mock(side_effect=[
        types.GenerateContentResponse(candidates=[types.Candidate(content=content)]),
        types.GenerateContentResponse(candidates=[types.Candidate(content=content, url_context_metadata=receipts)]),
    ])
    model = SimpleNamespace(model="gemini", max_output_tokens=1024, thinking_level=None,
                            client=SimpleNamespace(models=SimpleNamespace(generate_content=generate)))
    ws = WorkspaceState(workspace_id="receipts", root_path=tmp_path, context={"active_skill": "research"})
    tracker = SourceTracker()
    read = build_url_context_tool(ws, tracker, model, tool_description="Read supplied links")
    request = {"urls": [url, failed, url], "question": "What does the page say?"}
    assert "failed" in read.invoke(request)
    assert tracker.list_sources(ws) == []
    assert _research_source_contract_error(AgentRuntimeState("fast", ws), tracker)
    assert "Page evidence" in read.invoke(request)
    assert tracker.list_sources(ws) == [(1, url, url)]
    assert ws.context["web_search_source_count"] == 1
    assert not _research_source_contract_error(AgentRuntimeState("fast", ws), tracker)
