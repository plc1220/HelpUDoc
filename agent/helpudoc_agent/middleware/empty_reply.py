"""Ask once for a reply when a run would end with none.

Long runs in testing and production sometimes ended on an empty model message after many
tool calls. The user saw "Completed successfully." and no answer.
"""
from __future__ import annotations

import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware, AgentState, hook_config
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)

NUDGE_SOURCE = "lumo_empty_reply"
NUDGE_TEXT = (
    "[Lumo system note] You ended without a reply. Write your reply to the user's latest "
    "message now, from what you already found. Do not start new work. If you could not find "
    "or finish something, say so and ask the user for what you need."
)
# Their result is the reply: a card, a form or a proposal that the user sees.
_TOOLS_THAT_END_A_RUN = {"propose_skill", "workflow_action"}


def is_nudge(message: Any) -> bool:
    return isinstance(message, HumanMessage) and message.additional_kwargs.get("lc_source") == NUDGE_SOURCE


class EmptyReplyMiddleware(AgentMiddleware):
    @hook_config(can_jump_to=["model"])
    def after_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        messages = state.get("messages") or []
        last = messages[-1] if messages else None
        if not isinstance(last, AIMessage) or last.tool_calls or last.invalid_tool_calls:
            return None
        if str(last.text if isinstance(last.text, str) else last.text()).strip():
            return None
        for message in reversed(messages):
            if isinstance(message, HumanMessage):
                if is_nudge(message):
                    return None
                break
            if isinstance(message, ToolMessage) and message.name in _TOOLS_THAT_END_A_RUN:
                return None
        logger.warning("Run would have ended without a reply; asking the model once")
        nudge = HumanMessage(NUDGE_TEXT, additional_kwargs={"lc_source": NUDGE_SOURCE})
        return {"messages": [nudge], "jump_to": "model"}
