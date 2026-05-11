"""Resolve the public ``data_agent_tools`` module for monkeypatch compatibility.

Tests often patch ``agent.helpudoc_agent.data_agent_tools`` while runtime code
imports ``helpudoc_agent.data_agent_tools``. Those can be distinct ``sys.modules``
entries, so helpers must look up whichever alias is already loaded.
"""
from __future__ import annotations

import importlib
import sys
from types import ModuleType


def get_data_agent_tools_module() -> ModuleType:
    for name in (
        "agent.helpudoc_agent.data_agent_tools",
        "helpudoc_agent.data_agent_tools",
    ):
        mod = sys.modules.get(name)
        if mod is not None:
            return mod
    return importlib.import_module("helpudoc_agent.data_agent_tools")
