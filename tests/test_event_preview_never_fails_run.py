"""A cosmetic preview label must never be able to fail an agent run.

Regression coverage for `TypeError: Object of type ToolRuntime is not JSON serializable`.

LangChain injects a `ToolRuntime` into any tool declaring one -- `load_mcp_tools` uses
`runtime: SkipJsonSchema[ToolRuntime]`. When that tool call reached the v3 event stream,
`_event_text` encoded the args dict with `json.dumps(..., ensure_ascii=False)` and no `default=`,
so the encoder raised, propagated out of `_consume_event_stream`, and failed the whole run while
building a preview string. The sibling branch three lines below already passed `default=str`.
"""
from __future__ import annotations

from helpudoc_agent.api.routes.chat import _safe_json


class Unserializable:
    """Stands in for ToolRuntime: no json encoder, and a deliberately noisy repr."""

    def __repr__(self) -> str:
        return "<Unserializable runtime>"


def test_safe_json_encodes_unserializable_values_instead_of_raising() -> None:
    encoded = _safe_json({"server_name": "google-workspace", "runtime": Unserializable()})

    assert "google-workspace" in encoded
    assert "Unserializable" in encoded


def test_safe_json_preserves_ordinary_payloads() -> None:
    assert _safe_json({"a": 1, "b": "x"}) == '{"a": 1, "b": "x"}'


def test_safe_json_keeps_non_ascii_readable() -> None:
    # ensure_ascii=False is intentional: previews are read by humans.
    assert "研究" in _safe_json({"topic": "研究"})


def test_safe_json_survives_a_repr_that_itself_raises() -> None:
    """_safe_json must be total: `default=str` calls __str__/__repr__, which can also raise."""
    class Hostile:
        def __repr__(self) -> str:
            raise RuntimeError("repr exploded")

    # Must not raise, and must still name the offending type so the failure is diagnosable.
    encoded = _safe_json({"bad": Hostile()})

    assert isinstance(encoded, str)
    assert "Hostile" in encoded


def test_circular_structures_do_not_raise() -> None:
    payload: dict = {"name": "loop"}
    payload["self"] = payload

    assert isinstance(_safe_json(payload), str)
