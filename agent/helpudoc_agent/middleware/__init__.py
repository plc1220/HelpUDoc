"""Agent middleware extensions for HelpUDoc."""

from helpudoc_agent.middleware.a2ui_contract import A2UIContractMiddleware
from helpudoc_agent.middleware.implicit_input_guard import ImplicitInputGuardMiddleware

__all__ = ["A2UIContractMiddleware", "ImplicitInputGuardMiddleware"]
