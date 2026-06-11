"""Middleware that enforces structured A2UI gate tool calls at runtime."""
from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from langchain.agents.middleware.types import AgentMiddleware, AgentState, ModelRequest, ModelResponse, hook_config
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langgraph.runtime import Runtime

from helpudoc_agent.a2ui_contract import (
    find_gate_record,
    gate_instruction,
    next_pending_gate,
    normalize_gate_id,
    normalize_skill_id,
    record_gate_source,
    record_gate_violation,
    response_has_valid_a2ui_call,
)

logger = logging.getLogger(__name__)


def _runtime_context(runtime: Any) -> dict[str, Any] | None:
    context = getattr(runtime, "context", None)
    return context if isinstance(context, dict) else None


def _failed_contract_message(reason: str) -> AIMessage:
    return AIMessage(
        content=(
            "A2UI contract enforcement failed after one correction attempt. "
            f"{reason} The fallback input guard may synthesize an emergency interrupt."
        )
    )


class A2UIContractMiddleware(AgentMiddleware):
    """Require `workflow_action(action='ask_user_a2ui')` for pending gates."""

    def __init__(self, *, enabled: bool = True) -> None:
        super().__init__()
        self.enabled = enabled

    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        context = _runtime_context(runtime)
        gate = next_pending_gate(context)
        if gate is None:
            return None
        return {"messages": [SystemMessage(content=gate_instruction(gate))]}

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse | AIMessage:
        if not self.enabled:
            return handler(request)
        context = _runtime_context(request.runtime)
        gate = next_pending_gate(context)
        if gate is None:
            return handler(request)

        first_response = handler(request)
        valid, reason = response_has_valid_a2ui_call(first_response, gate)
        if valid:
            if context is not None:
                record_gate_source(context, gate, source="direct")
            return first_response

        retry_messages = list(request.messages or [])
        retry_messages.append(_failed_contract_message(reason))
        retry_messages.append(HumanMessage(content=gate_instruction(gate, correction=reason)))
        retry_response = handler(request.override(messages=retry_messages))
        valid, retry_reason = response_has_valid_a2ui_call(retry_response, gate)
        if valid:
            if context is not None:
                record_gate_source(context, gate, source="corrected")
            return retry_response

        if context is not None:
            record_gate_violation(context, gate, source="failed")
        logger.warning(
            "A2UI contract violation after retry: skill=%s gate=%s reason=%s",
            gate.get("skill_id"),
            gate.get("gate_id"),
            retry_reason or reason,
        )
        return retry_response

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse | AIMessage:
        if not self.enabled:
            return await handler(request)
        context = _runtime_context(request.runtime)
        gate = next_pending_gate(context)
        if gate is None:
            return await handler(request)

        first_response = await handler(request)
        valid, reason = response_has_valid_a2ui_call(first_response, gate)
        if valid:
            if context is not None:
                record_gate_source(context, gate, source="direct")
            return first_response

        retry_messages = list(request.messages or [])
        retry_messages.append(_failed_contract_message(reason))
        retry_messages.append(HumanMessage(content=gate_instruction(gate, correction=reason)))
        retry_response = await handler(request.override(messages=retry_messages))
        valid, retry_reason = response_has_valid_a2ui_call(retry_response, gate)
        if valid:
            if context is not None:
                record_gate_source(context, gate, source="corrected")
            return retry_response

        if context is not None:
            record_gate_violation(context, gate, source="failed")
        logger.warning(
            "A2UI contract violation after retry: skill=%s gate=%s reason=%s",
            gate.get("skill_id"),
            gate.get("gate_id"),
            retry_reason or reason,
        )
        return retry_response

    @hook_config(can_jump_to=["model"])
    def after_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        context = _runtime_context(runtime)
        gate = next_pending_gate(context)
        if gate is None:
            return None
        messages = state.get("messages") or []
        last_ai = next((message for message in reversed(messages) if isinstance(message, AIMessage)), None)
        if last_ai is None:
            return None
        valid, reason = response_has_valid_a2ui_call(last_ai, gate)
        if valid:
            return None
        # Do not let prose-only phantom UI be treated as progress. One model-level
        # retry already happened in wrap_model_call; the legacy guard runs after
        # this middleware and may synthesize an emergency interrupt.
        if context is not None:
            record = find_gate_record(
                context,
                skill_id=normalize_skill_id(gate.get("skill_id")),
                gate_id=normalize_gate_id(gate.get("gate_id")),
            )
            if not (isinstance(record, dict) and record.get("source") == "failed"):
                record_gate_violation(context, gate, source="failed")
        return None

    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self.after_model(state, runtime)
