"""Guarding a tool must preserve its model-facing input contract."""
from unittest.mock import patch

import pytest
from langchain_core.tools import BaseTool, Tool, tool
from langchain_google_genai import ChatGoogleGenerativeAI

from helpudoc_agent.mcp_manager import _preflight_gemini_tools
from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tool_guard import GuardedTool
from helpudoc_agent.tools.workspace.builtins.calendar import build_calendar_read_tool


class SchemaLessTool(BaseTool):
    name: str = "typed_read"
    description: str = "Read a sequence."

    def _run(self, sequence: int) -> str:
        return str(sequence)


@pytest.mark.parametrize("kind", ["simple", "calendar", "typed"])
def test_guard_preserves_schema_less_tool_binding_and_execution(tmp_path, kind):
    state = WorkspaceState(workspace_id="schema-test", root_path=tmp_path)
    if kind == "simple":
        original = Tool(name="legacy_read", description="Read text.", func=lambda text: text)
        field, value, expected = "__arg1", "hello", "hello"
    elif kind == "calendar":
        original = build_calendar_read_tool(state)
        field, value, expected = "__arg1", "meeting:other", "outside"
    else:
        original = SchemaLessTool()
        field, value, expected = "sequence", 7, "7"
    guarded = GuardedTool.from_tool(original, workspace_state=state)

    with patch("langchain_google_genai.chat_models.Client"):
        model = ChatGoogleGenerativeAI(
            model="gemini-3.5-flash", api_key="test-key", vertexai=False
        )
        bound = model.bind_tools([guarded])
    parameters = bound.kwargs["tools"][0]["function"]["parameters"]
    assert set(parameters["properties"]) == {field}
    assert parameters["properties"][field]["type"] == (
        "integer" if kind == "typed" else "string"
    )
    assert parameters["required"] == [field]
    # Check the actual converted Gemini declaration, not just OpenAI-format binding.
    _preflight_gemini_tools([guarded])
    assert expected in guarded.invoke({field: value})
    assert expected in guarded.invoke({
        "type": "tool_call", "id": "call-test", "name": guarded.name,
        "args": {field: value},
    }).content


def test_guard_keeps_explicit_schema(tmp_path):
    @tool
    def read_range(start: int, limit: int = 10) -> str:
        """Read a range."""
        return f"{start}:{limit}"

    state = WorkspaceState(workspace_id="schema-test", root_path=tmp_path)
    guarded = GuardedTool.from_tool(read_range, workspace_state=state)
    assert guarded.args_schema is read_range.args_schema
    assert guarded.invoke({"start": 2}) == "2:10"
