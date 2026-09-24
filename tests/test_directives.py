"""The agent's copy of the composer directive parser.

Shares its vectors with `frontend/tests/composerDirectives.test.ts`. The two
implementations are in different languages, so only matching tests keep them
from drifting the way the three start-anchored copies did.
"""
import json

import pytest

from helpudoc_agent.api.directives import _extract_directive_from_text


@pytest.mark.parametrize(
    "text,skill_id,prompt",
    [
        ("@kb:General Knowledge /skill data/analyze", "data/analyze", "@kb:General Knowledge"),
        (
            "/skill data/analyze @kb:General Knowledge summarise it",
            "data/analyze",
            "@kb:General Knowledge summarise it",
        ),
        ("@kb:General Knowledge\n/skill data/analyze", "data/analyze", "@kb:General Knowledge"),
        ("@report.pdf /skill data/analyze", "data/analyze", "@report.pdf"),
        (
            "read @report.pdf /skill data/analyze then summarise",
            "data/analyze",
            "read @report.pdf then summarise",
        ),
        ("(/skill data/analyze) go", "data/analyze", "() go"),
        # The lead-in is addressed to the product, so it goes with the directive.
        ("please use /skill data/analyze now", "data/analyze", "now"),
        ("Use /skill proposal-writing draft a proposal", "proposal-writing", "draft a proposal"),
        ("we use /skill data/analyze here", "data/analyze", "we here"),
    ],
)
def test_skill_directive_is_found_anywhere(text, skill_id, prompt):
    directive, rest = _extract_directive_from_text(text)
    assert directive is not None, text
    assert directive.kind == "skill"
    assert directive.skillId == skill_id
    assert rest == prompt


def test_mcp_directive_is_found_after_a_mention():
    directive, rest = _extract_directive_from_text("@kb:Policies /mcp google-workspace find it")
    assert directive is not None
    assert directive.kind == "mcp"
    assert directive.serverId == "google-workspace"
    assert rest == "@kb:Policies find it"


@pytest.mark.parametrize(
    "text",
    [
        "see https://example.test/skill/data for details",
        "look at docs/skill notes.md",
        "/skill",
        "nothing to see here",
    ],
)
def test_text_without_a_directive_is_left_alone(text):
    directive, rest = _extract_directive_from_text(text)
    assert directive is None
    assert rest == text


def test_the_first_directive_wins():
    directive, _ = _extract_directive_from_text("/skill data/analyze and /skill research")
    assert directive is not None
    assert directive.skillId == "data/analyze"


def test_whichever_of_skill_or_mcp_comes_first_wins():
    directive, _ = _extract_directive_from_text("/mcp google-workspace then /skill research")
    assert directive is not None
    assert directive.kind == "mcp"

    directive, _ = _extract_directive_from_text("/skill research then /mcp google-workspace")
    assert directive is not None
    assert directive.kind == "skill"


def test_a_directive_block_still_takes_precedence():
    payload = json.dumps({"kind": "skill", "skillId": "data/analyze"})
    directive, rest = _extract_directive_from_text(
        f"<<<HELPUDOC_DIRECTIVE\n{payload}\n>>>\n@kb:General Knowledge"
    )
    assert directive is not None
    assert directive.skillId == "data/analyze"
    assert rest == "@kb:General Knowledge"


def test_the_legacy_prompt_shape_still_parses():
    text = (
        'Use the "research" skill for this task. First call load_skill with "research" '
        "to load the skill instructions, then follow that skill closely. "
        "User request: summarise the market"
    )
    directive, rest = _extract_directive_from_text(text)
    assert directive is not None
    assert directive.skillId == "research"
    assert rest == "summarise the market"
