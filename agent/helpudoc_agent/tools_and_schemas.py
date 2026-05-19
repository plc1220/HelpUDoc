"""Tool creation helpers (compatibility re-exports).

Implementation lives under ``helpudoc_agent.tools.workspace``; this module keeps
stable import paths for the API, tests, YAML entrypoints, and legacy private helpers.
"""
from __future__ import annotations

from langgraph.types import interrupt

from .plan_gates import is_plan_approved as _is_plan_approved
from .tools.workspace import (
    GeminiClientManager,
    MissingToolBuilderError,
    RequestClarificationInput,
    StructuredWebAnswer,
    StructuredWebSource,
    ToolFactory,
    build_gemini_image_tool,
    build_google_search_tool,
    build_url_context_tool,
    interrupt_with_retry as _interrupt_with_retry,
    parse_structured_web_answer as _parse_structured_web_answer,
)
from .tools.workspace.constants import (
    MAX_DISTINCT_SKILLS_PER_TURN as _MAX_DISTINCT_SKILLS_PER_TURN,
    MAX_SKILL_LOAD_ATTEMPTS_PER_TURN as _MAX_SKILL_LOAD_ATTEMPTS_PER_TURN,
    MIN_GEMINI_TIMEOUT_S as _MIN_GEMINI_TIMEOUT_S,
)
from .tools.workspace.interrupt_helpers import (
    dict_has_keys as _dict_has_keys,
    edited_action_args as _edited_action_args,
    first_decision as _first_decision,
)
from .tools.workspace.json_args import (
    parse_json_dict_arg as _parse_json_dict_arg,
    parse_json_list_arg as _parse_json_list_arg,
)
from .tools.workspace.policy import (
    apply_search_policy_guard as _apply_search_policy_guard,
    get_active_skill_policy as _get_active_skill_policy,
    plan_gate_message as _plan_gate_message,
    plan_gate_with_presearch_message as _plan_gate_with_presearch_message,
)
from .tools.workspace.timeouts import (
    DEFAULT_HTTP_TIMEOUT as _DEFAULT_HTTP_TIMEOUT,
    DEFAULT_SEARCH_HTTP_TIMEOUT as _DEFAULT_SEARCH_HTTP_TIMEOUT,
    DEFAULT_SEARCH_TIMEOUT as _DEFAULT_SEARCH_TIMEOUT,
    SEARCH_EXECUTOR as _SEARCH_EXECUTOR,
    clamp_min as _clamp_min,
    env_int as _env_int,
    invoke_lc_with_timeout as _invoke_lc_with_timeout,
    seconds_to_ms as _seconds_to_ms,
)

__all__ = [
    "GeminiClientManager",
    "MissingToolBuilderError",
    "RequestClarificationInput",
    "StructuredWebAnswer",
    "StructuredWebSource",
    "ToolFactory",
    "build_gemini_image_tool",
    "build_google_search_tool",
    "build_url_context_tool",
    "interrupt",
]
