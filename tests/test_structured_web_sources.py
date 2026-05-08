"""Source extraction for grounded Google GenAI structured web tools."""

from langchain_core.messages import AIMessage

from helpudoc_agent.tools_and_schemas import _parse_structured_web_answer


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
    summary, sources = _parse_structured_web_answer(ai)
    assert summary == "Done."
    assert len(sources) == 1
    assert sources[0]["title"] == "Example"
    assert "example.com" in sources[0]["url"]
