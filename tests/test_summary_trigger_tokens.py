import pytest

from helpudoc_agent.runtime import agent_registry


@pytest.mark.parametrize(
    "raw, expected",
    [
        (None, 170000),
        ("", 170000),
        ("20000", 20000),
        ("0", 170000),
        ("-5", 170000),
        ("not-a-number", 170000),
    ],
)
def test_summary_trigger_tokens_defaults_to_production_value(monkeypatch, raw, expected):
    # Production must keep 170000 unless a cluster sets a valid override on purpose.
    if raw is None:
        monkeypatch.delenv("HELPUDOC_SUMMARY_TRIGGER_TOKENS", raising=False)
    else:
        monkeypatch.setenv("HELPUDOC_SUMMARY_TRIGGER_TOKENS", raw)

    assert agent_registry._summary_trigger_tokens() == expected
