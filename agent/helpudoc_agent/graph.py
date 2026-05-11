"""Compatibility shim for legacy ``helpudoc_agent.graph`` imports.

Prefer :mod:`helpudoc_agent.runtime.agent_registry` for new code.
"""
from __future__ import annotations

from .runtime.agent_registry import AgentRegistry, _clone_preservable_context

__all__ = ["AgentRegistry", "_clone_preservable_context"]
