from langchain_core.tools import tool
from langgraph.errors import GraphInterrupt
from langgraph.types import Interrupt
import pytest

from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tool_guard import GuardedTool


def test_guarded_tool_reraises_langgraph_interrupt(tmp_path):
    pending = Interrupt(value={"kind": "approval"}, id="approval-interrupt")

    @tool
    def request_plan_approval(plan_title: str) -> str:
        """Pause execution for plan approval."""
        raise GraphInterrupt((pending,))

    workspace = WorkspaceState(workspace_id="guard-interrupt", root_path=tmp_path)
    guarded = GuardedTool.from_tool(request_plan_approval, workspace_state=workspace)

    with pytest.raises(GraphInterrupt) as caught:
        guarded.invoke(
            {
                "id": "tool-call-approval",
                "name": "request_plan_approval",
                "type": "tool_call",
                "args": {"plan_title": "Research plan"},
            }
        )

    assert caught.value.args[0][0].id == "approval-interrupt"


def test_admin_block_stops_next_tool_call_for_already_active_skill(tmp_path):
    marker = tmp_path / "execution-block"
    @tool
    def harmless_tool() -> str:
        """Return a value."""
        return "executed"
    workspace = WorkspaceState(workspace_id="block-test", root_path=tmp_path)
    workspace.context.update({"active_skill": "personal/test", "skill_allow_ids": ["personal/test"],
                              "active_skill_block_paths": [str(marker)]})
    guarded = GuardedTool.from_tool(harmless_tool, workspace_state=workspace)
    assert guarded.invoke({}) == "executed"
    marker.write_text("Anomaly")
    assert "blocked by an administrator" in guarded.invoke({})
