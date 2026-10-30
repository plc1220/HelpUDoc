"""propose_skill: the only way the agent helps create a skill.

On 2026-10-12 a user asked the agent to convert a Word document into skills and it wrote
ten folders into the shared catalog. Proposals write nothing; the user saves each one as
a private draft through the governance API.
"""
import json

import pytest

from helpudoc_agent.runtime.agent_registry import (
    SKILL_BUILDER_PERSONA,
    SKILL_PROPOSAL_PROMPT,
    _runtime_tool_names,
)
from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tools.workspace.builtins.skill_proposals import (
    PROPOSAL_TYPE,
    build_propose_skill_tool,
    workspace_skill_proposals_enabled,
)

SKILL_MD = "---\nname: Contract fairness\ndescription: Identify clauses that create an imbalance.\n---\n\n# Contract fairness\n"


def _call(tmp_path, **overrides):
    state = WorkspaceState(workspace_id="proposal-test", root_path=tmp_path)
    tool = build_propose_skill_tool(state)
    args = {
        "skill_id": "contract-fairness",
        "name": "Contract fairness",
        "description": "Identify clauses that create an imbalance.",
        "files": [
            {"path": "references/checklist.md", "content": "- Unilateral variation\n"},
            {"path": "SKILL.md", "content": SKILL_MD},
        ],
        **overrides,
    }
    return tool.invoke(args), state


def test_a_valid_proposal_returns_the_full_skill_and_writes_nothing(tmp_path):
    output, state = _call(tmp_path)

    proposal = json.loads(output)
    assert proposal["type"] == PROPOSAL_TYPE
    assert proposal["skillId"] == "contract-fairness"
    assert [file["path"] for file in proposal["files"]] == ["SKILL.md", "references/checklist.md"]
    assert proposal["files"][0]["content"] == SKILL_MD  # full content, not a preview
    # The exact batch POST /skills/drafts/:id/builder-actions accepts.
    assert proposal["actions"][0] == {
        "type": "create_skill",
        "skillId": "contract-fairness",
        "name": "Contract fairness",
        "description": "Identify clauses that create an imbalance.",
    }
    assert [action["type"] for action in proposal["actions"][1:]] == ["upsert_text", "upsert_text"]
    assert all(action["skillId"] == "contract-fairness" for action in proposal["actions"])
    assert list(tmp_path.iterdir()) == []
    assert state.context["skill_proposals_this_turn"] == ["contract-fairness"]


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"skill_id": "Contract Fairness"}, "skill_id must be lowercase"),
        ({"files": [{"path": "references/a.md", "content": "x"}]}, "must include SKILL.md"),
        ({"files": [{"path": "SKILL.md", "content": "# no frontmatter"}]}, "frontmatter that has a name"),
        ({"files": [{"path": "SKILL.md", "content": "  " + SKILL_MD}]}, "frontmatter that has a name"),
        ({"files": [{"path": "SKILL.md", "content": "---\nname: x\n---\n"}]}, "must have a description"),
        ({"files": [{"path": "SKILL.md", "content": "---\nname: x\ndescription: y\ntools: []\n---\n"}]}, "omit tools"),
        ({"files": [{"path": "SKILL.md", "content": SKILL_MD}, {"path": "/etc/passwd", "content": "x"}]}, "relative path"),
        ({"files": [{"path": "SKILL.md", "content": SKILL_MD}, {"path": "skills/x/SKILL.md", "content": "x"}]}, "must not start with skills/"),
        ({"files": [{"path": "SKILL.md", "content": SKILL_MD}, {"path": "references/../SKILL.md", "content": "x"}]}, "'..'"),
        ({"files": [{"path": "SKILL.md", "content": SKILL_MD}, {"path": "notes.md", "content": "x"}]}, "outside the allowed skill layout"),
        ({"files": [{"path": "SKILL.md", "content": SKILL_MD}, {"path": "scripts/run.exe", "content": "x"}]}, "executable binary"),
        ({"files": [{"path": "SKILL.md", "content": SKILL_MD}, {"path": "SKILL.md", "content": SKILL_MD}]}, "more than once"),
        ({"files": [{"path": "SKILL.md", "content": SKILL_MD}, {"path": "references/big.md", "content": "x" * 200_001}]}, "longer than"),
    ],
)
def test_an_invalid_proposal_is_returned_to_the_model_to_fix(tmp_path, overrides, expected):
    output, state = _call(tmp_path, **overrides)

    assert output.startswith("Skill proposal rejected."), output
    assert expected in output
    assert "skill_proposals_this_turn" not in state.context
    assert list(tmp_path.iterdir()) == []


def test_proposals_are_on_unless_switched_off(monkeypatch):
    monkeypatch.delenv("ENABLE_WORKSPACE_SKILL_PROPOSALS", raising=False)
    assert workspace_skill_proposals_enabled()
    monkeypatch.setenv("ENABLE_WORKSPACE_SKILL_PROPOSALS", "false")
    assert not workspace_skill_proposals_enabled()


CONFIGURED = {name: {} for name in ("read_file", "write_file", "edit_file", "load_skill", "list_skills", "propose_skill")}


def test_a_general_run_gets_propose_skill():
    assert "propose_skill" in _runtime_tool_names(["read_file"], CONFIGURED, persona="general", proposals_enabled=True)
    assert "propose_skill" in _runtime_tool_names([], CONFIGURED, persona="general", proposals_enabled=True)


def test_switching_proposals_off_removes_the_tool():
    assert "propose_skill" not in _runtime_tool_names(["read_file"], CONFIGURED, persona="general", proposals_enabled=False)
    assert "propose_skill" not in _runtime_tool_names([], CONFIGURED, persona="general", proposals_enabled=False)


def test_the_skill_creator_never_gets_write_tools_or_propose_skill():
    # With no skill declaring tools the fallback binds every tool; denials must come after it.
    for declared in ([], ["read_file"]):
        names = _runtime_tool_names(declared, CONFIGURED, persona=SKILL_BUILDER_PERSONA, proposals_enabled=True)
        assert "write_file" not in names and "edit_file" not in names, names
        assert "propose_skill" not in names, names


def test_the_prompt_routes_skill_creation_to_propose_skill():
    assert "propose_skill" in SKILL_PROPOSAL_PROMPT
    assert "read-only" in SKILL_PROPOSAL_PROMPT
    assert "private draft" in SKILL_PROPOSAL_PROMPT
