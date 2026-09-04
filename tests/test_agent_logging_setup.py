"""Regression: agent records reach stdout as parseable Cloud Logging payloads.

Before ``configure_logging`` existed the root logger had no handler, so uvicorn's
own loggers were the only ones that emitted anything and every ``helpudoc_agent``
``info`` call was silently discarded. These tests pin the properties GKE log
collection depends on.
"""

import json
import logging
import warnings

import pytest

from helpudoc_agent.logging_setup import (
    StructuredFormatter,
    configure_logging,
    reset_logging_for_tests,
)


@pytest.fixture
def json_logging(monkeypatch, capsys):
    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.setenv("LOG_LEVEL", "INFO")
    root = logging.getLogger()
    saved_handlers, saved_level = list(root.handlers), root.level
    reset_logging_for_tests()
    configure_logging(force=True)
    yield capsys
    reset_logging_for_tests()
    root.handlers = saved_handlers
    root.setLevel(saved_level)
    logging.captureWarnings(False)


def _emitted(capsys):
    out, err = capsys.readouterr()
    assert err == "", f"logs must not reach stderr, GKE files that stream as ERROR: {err!r}"
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def test_info_is_emitted_and_extra_becomes_structured_fields(json_logging):
    logging.getLogger("helpudoc_agent.demo").info("run started", extra={"runId": "r-1"})

    (entry,) = _emitted(json_logging)
    assert entry["severity"] == "INFO"
    assert entry["message"] == "run started"
    assert entry["logger"] == "helpudoc_agent.demo"
    assert entry["runId"] == "r-1"


def test_warning_is_not_reported_as_error(json_logging):
    logging.getLogger("helpudoc_agent.demo").warning("degraded")

    (entry,) = _emitted(json_logging)
    assert entry["severity"] == "WARNING"


def test_exception_stays_in_a_single_entry(json_logging):
    try:
        raise KeyError("missing")
    except KeyError:
        logging.getLogger("helpudoc_agent.demo").exception("run failed")

    entries = _emitted(json_logging)
    # One entry, not one per traceback frame -- the whole point of the JSON line.
    assert len(entries) == 1
    assert entries[0]["severity"] == "ERROR"
    assert "Traceback (most recent call last)" in entries[0]["message"]
    assert "KeyError: 'missing'" in entries[0]["message"]


def test_library_warnings_are_captured(json_logging):
    warnings.warn("beta protocol", UserWarning)

    entries = _emitted(json_logging)
    assert [e["severity"] for e in entries] == ["WARNING"]
    assert "beta protocol" in entries[0]["message"]


def test_uvicorn_loggers_are_routed_through_the_root_handler(json_logging):
    # Uvicorn ships propagate=False and its own handlers; without the reset in
    # configure_logging its records would bypass the structured formatter.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        assert logging.getLogger(name).propagate is True
        assert logging.getLogger(name).handlers == []

    logging.getLogger("uvicorn.access").info('GET /health 200')
    (entry,) = _emitted(json_logging)
    assert entry["logger"] == "uvicorn.access"


def test_unserialisable_extra_does_not_raise(json_logging):
    logging.getLogger("helpudoc_agent.demo").info("odd", extra={"obj": object()})

    (entry,) = _emitted(json_logging)
    assert entry["message"] == "odd"
    assert isinstance(entry["obj"], str)


def test_uvicorn_color_message_is_dropped():
    record = logging.LogRecord(
        name="uvicorn.error", level=logging.INFO, pathname="s.py", lineno=1,
        msg="Started server process [%d]", args=(7,), exc_info=None,
    )
    record.color_message = "Started server process [\x1b[36m%d\x1b[0m]"

    payload = json.loads(StructuredFormatter().format(record))
    assert payload["message"] == "Started server process [7]"
    assert "color_message" not in payload


def test_configure_logging_is_idempotent(monkeypatch):
    monkeypatch.setenv("LOG_FORMAT", "json")
    root = logging.getLogger()
    saved_handlers, saved_level = list(root.handlers), root.level
    try:
        reset_logging_for_tests()
        configure_logging(force=True)
        configure_logging()
        configure_logging()
        assert len(root.handlers) == 1
    finally:
        reset_logging_for_tests()
        root.handlers = saved_handlers
        root.setLevel(saved_level)
        logging.captureWarnings(False)


def test_text_format_is_used_outside_the_cluster(monkeypatch):
    monkeypatch.delenv("LOG_FORMAT", raising=False)
    monkeypatch.delenv("KUBERNETES_SERVICE_HOST", raising=False)
    root = logging.getLogger()
    saved_handlers, saved_level = list(root.handlers), root.level
    try:
        reset_logging_for_tests()
        configure_logging(force=True)
        assert not isinstance(root.handlers[0].formatter, StructuredFormatter)
    finally:
        reset_logging_for_tests()
        root.handlers = saved_handlers
        root.setLevel(saved_level)
        logging.captureWarnings(False)
