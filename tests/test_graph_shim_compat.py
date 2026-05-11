from __future__ import annotations


def test_graph_module_reexports_runtime_agent_registry() -> None:
    from helpudoc_agent import graph as graph_mod
    from helpudoc_agent.runtime import agent_registry as registry_mod

    assert graph_mod.AgentRegistry is registry_mod.AgentRegistry
    assert graph_mod._clone_preservable_context is registry_mod._clone_preservable_context


def test_legacy_helpudoc_agent_graph_import_still_works() -> None:
    from helpudoc_agent.graph import AgentRegistry as Legacy
    from helpudoc_agent.runtime.agent_registry import AgentRegistry as Canonical

    assert Legacy is Canonical
