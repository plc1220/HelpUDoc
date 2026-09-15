"""The Skill Creator persona: prompt, toolset, and runtime isolation.

The persona was advertised in `/agents` but never given a system prompt, so builder runs
used the general one and behaved like a general assistant -- writing files and describing
them in prose instead of proposing them. `SkillCreatorDialog` fills its Proposed draft
panel only from a fenced json block, so the panel stayed empty.
"""
from helpudoc_agent.runtime.agent_registry import (
    GENERAL_SYSTEM_PROMPT,
    SKILL_BUILDER_DENIED_TOOLS,
    SKILL_BUILDER_PERSONA,
    SKILL_BUILDER_SYSTEM_PROMPT,
)


def _resolve_persona(registry_cls, name):
    return registry_cls._resolve_persona(registry_cls, name)  # noqa: SLF001


def test_persona_resolves_only_for_the_builder():
    from helpudoc_agent.runtime.agent_registry import AgentRegistry

    for name in (SKILL_BUILDER_PERSONA, "skill-builder:pro", "SKILL-BUILDER"):
        assert _resolve_persona(AgentRegistry, name) == SKILL_BUILDER_PERSONA, name
    # Everything else keeps the general prompt. A near-miss must not silently acquire a
    # prompt that forbids writing files.
    for name in ("fast", "pro", "lite", "general-assistant", "skill-builderx", "", None):
        assert _resolve_persona(AgentRegistry, name) == "general", name


def test_persona_does_not_change_the_model_tier():
    """`_resolve_mode` picks a model, `_resolve_persona` picks a prompt.

    Folding the persona into the tier would have pinned the Creator to one model for the
    wrong reason, and changed which model every unrecognised agent name resolves to.
    """
    from helpudoc_agent.runtime.agent_registry import AgentRegistry

    assert AgentRegistry._resolve_mode(AgentRegistry, SKILL_BUILDER_PERSONA) == "fast"
    assert AgentRegistry._resolve_mode(AgentRegistry, "skill-builder:pro") == "pro"
    assert AgentRegistry._resolve_mode(AgentRegistry, "pro") == "pro"


def test_prompt_states_the_contract_the_dialog_parses():
    prompt = SKILL_BUILDER_SYSTEM_PROMPT
    # The dialog reads a fenced json block containing `actions`; nothing else fills the
    # Proposed draft panel.
    assert "```json" in prompt
    assert '"actions"' in prompt
    for action in ("create_skill", "upsert_text"):
        assert action in prompt, action
    # It proposes; it does not act.
    assert "never create the skill yourself" in prompt.lower() or "do not write" in prompt.lower()
    assert prompt != GENERAL_SYSTEM_PROMPT


def test_write_tools_are_withheld_from_the_builder():
    """The prompt asks it not to write; this is what stops it.

    A stray skill reached the runtime catalog while the builder ran on the general
    prompt, so declining to write cannot rest on instructions alone.
    """
    for name in ("write_file", "edit_file", "upload_files", "run_skill_python_script"):
        assert name in SKILL_BUILDER_DENIED_TOOLS, name
    # Reading is how it learns from attached context files, so it must survive.
    for name in ("read_file", "list_skills", "load_skill"):
        assert name not in SKILL_BUILDER_DENIED_TOOLS, name
