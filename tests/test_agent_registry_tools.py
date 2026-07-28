from helpudoc_agent.runtime.agent_registry import _include_always_available_tool_groups


def test_knowledge_navigation_is_available_when_skills_declare_other_tools() -> None:
    resolved = _include_always_available_tool_groups(
        ["document_inspection"],
        {
            "document_inspection": object(),
            "knowledge_navigation": object(),
            "list_skills": object(),
            "load_skill": object(),
        },
    )

    assert resolved == [
        "document_inspection",
        "load_skill",
        "list_skills",
        "knowledge_navigation",
    ]
