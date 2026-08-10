from __future__ import annotations

import json

from openpyxl import Workbook

from helpudoc_agent.document_tool_guard import (
    LOOP_BREAK_ERROR_CODE,
    detect_signature_cycle,
    normalize_document_tool_signature,
    reset_document_tool_run_state,
)
from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tool_guard import GuardedTool
from helpudoc_agent.tools.workspace.builtins.document_inspection import (
    build_document_inspection_tools,
)


def _signature(tool_name: str, **payload):
    return normalize_document_tool_signature(tool_name, payload)


def test_signature_normalizes_key_order_whitespace_and_defaults() -> None:
    baseline = _signature("inspect_document", file_path="/book.xlsx", sheet_name="Data")
    assert baseline == _signature(
        "inspect_document",
        sheet_name=" Data ",
        file_path="book.xlsx",
    )
    # Omitted and explicitly-default arguments are the same call.
    assert baseline == _signature(
        "inspect_document",
        file_path="\\book.xlsx",
        sheet_name="Data",
        page_start=1,
        page_end=5,
        slide_start=1,
        slide_end=5,
        item_start=1,
        item_end=40,
        cell_range=None,
    )
    assert baseline == _signature(
        "inspect_document",
        file_path="./book.xlsx",
        sheet_name="Data",
        cell_range="A1:J25",
    )
    # Case and $ anchors do not change an Excel range.
    assert _signature(
        "inspect_document", file_path="/b.xlsx", sheet_name="S", cell_range="a1:b2"
    ) == _signature(
        "inspect_document", file_path="/b.xlsx", sheet_name="S", cell_range="$A$1:$B$2"
    )


def test_signature_keeps_meaningfully_different_calls_distinct() -> None:
    base = _signature("inspect_document", file_path="/book.xlsx", sheet_name="Data")
    assert base != _signature("inspect_document", file_path="/book.xlsx", sheet_name="Other")
    assert base != _signature(
        "inspect_document", file_path="/book.xlsx", sheet_name="Data", cell_range="A1:B99"
    )
    assert _signature(
        "inspect_document", file_path="/b.xlsx", sheet_name="S", cell_range="A1:B2"
    ) != _signature(
        "inspect_document", file_path="/b.xlsx", sheet_name="S", cell_range="A1:B3"
    )
    assert _signature("inspect_document", file_path="deck.pptx", slide_start=1, slide_end=2) != (
        _signature("inspect_document", file_path="deck.pptx", slide_start=2, slide_end=2)
    )
    assert _signature("search_document", file_path="/b.xlsx", query="revenue") != _signature(
        "search_document", file_path="/b.xlsx", query="revenue 2025"
    )
    # Case-only query differences are the same search (search is case-insensitive).
    assert _signature("search_document", file_path="/b.xlsx", query="Revenue") == _signature(
        "search_document", file_path="/b.xlsx", query="  revenue "
    )
    assert normalize_document_tool_signature("write_file", {"file_path": "/a.md"}) is None
    assert normalize_document_tool_signature("inspect_document", "not-a-dict") is None


def test_detect_signature_cycle_periods_and_negatives() -> None:
    assert detect_signature_cycle(["a", "a"]) is None
    assert detect_signature_cycle(["a", "a", "a"]) == (1, ["a"])
    assert detect_signature_cycle(["a", "b", "a", "b"]) is None
    assert detect_signature_cycle(["a", "b"] * 3) == (2, ["a", "b"])
    assert detect_signature_cycle(["a", "b", "c"] * 3) == (3, ["a", "b", "c"])
    assert detect_signature_cycle(["a", "b", "c", "d"] * 3) == (4, ["a", "b", "c", "d"])
    # Five distinct calls repeated three times exceed the tracked period.
    assert detect_signature_cycle(["a", "b", "c", "d", "e"] * 3) is None
    # Unique enumeration (for example one range per sheet) never trips.
    assert detect_signature_cycle([f"s{index}" for index in range(20)]) is None


def _guarded_document_tools(tmp_path, monkeypatch):
    """Guarded document tools plus a counter of real tool executions.

    ``_resolve_document`` runs exactly once per executed document tool call, so
    counting it distinguishes real reads from cache hits and loop breaks.
    """
    from helpudoc_agent.tools.workspace.builtins import document_inspection

    workbook_path = tmp_path / "book.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Data"
    sheet.append(["Region", "Revenue"])
    sheet.append(["Malaysia", 125000])
    workbook.save(workbook_path)

    workspace = WorkspaceState(workspace_id="docs", root_path=tmp_path)
    calls: list[str] = []
    original_resolve = document_inspection._resolve_document

    def _counting_resolve(root, file_path):
        calls.append(str(file_path))
        return original_resolve(root, file_path)

    monkeypatch.setattr(document_inspection, "_resolve_document", _counting_resolve)

    guarded = {
        tool.name: GuardedTool.from_tool(tool, workspace_state=workspace)
        for tool in build_document_inspection_tools(workspace)
    }
    return workspace, guarded, calls


def test_guarded_document_tool_caches_exact_repeats(tmp_path, monkeypatch) -> None:
    workspace, guarded, calls = _guarded_document_tools(tmp_path, monkeypatch)
    payload = {"file_path": "book.xlsx", "sheet_name": "Data", "cell_range": "A1:B2"}

    first = guarded["inspect_document"].invoke(dict(payload))
    # Same call, different key order and whitespace: served from the run cache.
    second = guarded["inspect_document"].invoke(
        {"cell_range": " a1:b2 ", "sheet_name": "Data", "file_path": "/book.xlsx"}
    )

    assert json.loads(first)["status"] == "ok"
    assert second == first
    assert len(calls) == 1

    # A different range is a different call and reaches the tool.
    guarded["inspect_document"].invoke(
        {"file_path": "book.xlsx", "sheet_name": "Data", "cell_range": "A1:B1"}
    )
    assert len(calls) == 2


def test_guarded_document_tool_breaks_repeat_cycles(tmp_path, monkeypatch) -> None:
    workspace, guarded, calls = _guarded_document_tools(tmp_path, monkeypatch)
    payload = {"file_path": "book.xlsx", "sheet_name": "Data", "cell_range": "A1:B2"}

    guarded["inspect_document"].invoke(dict(payload))
    guarded["inspect_document"].invoke(dict(payload))
    third = json.loads(guarded["inspect_document"].invoke(dict(payload)))

    assert third["status"] == "error"
    assert third["errorCode"] == LOOP_BREAK_ERROR_CODE
    assert third["retryable"] is False
    assert third["cyclePeriod"] == 1
    assert third["repetitions"] == 3
    assert third["suggestedNextCall"]
    # The tool itself ran once; the repeats were cached then loop-broken.
    assert len(calls) == 1


def test_guarded_document_tool_breaks_alternating_cycles(tmp_path, monkeypatch) -> None:
    workspace, guarded, _calls = _guarded_document_tools(tmp_path, monkeypatch)
    inspect_payload = {"file_path": "book.xlsx", "sheet_name": "Data", "cell_range": "A1:B2"}
    search_payload = {"file_path": "book.xlsx", "query": "Malaysia"}

    results = []
    for _ in range(3):
        results.append(guarded["inspect_document"].invoke(dict(inspect_payload)))
        results.append(guarded["search_document"].invoke(dict(search_payload)))

    last = json.loads(results[-1])
    assert last["errorCode"] == LOOP_BREAK_ERROR_CODE
    assert last["cyclePeriod"] == 2
    assert last["tool"] == "search_document"
    # The first two rounds were answered normally.
    assert json.loads(results[0])["status"] == "ok"
    assert json.loads(results[3])["status"] == "ok"


def test_guarded_document_tool_allows_unique_batch_reads(tmp_path, monkeypatch) -> None:
    workspace, guarded, calls = _guarded_document_tools(tmp_path, monkeypatch)

    for row in range(1, 9):
        payload = {
            "file_path": "book.xlsx",
            "sheet_name": "Data",
            "cell_range": f"A{row}:B{row}",
        }
        result = json.loads(guarded["inspect_document"].invoke(payload))
        assert result["status"] == "ok", result

    assert len(calls) == 8


def test_document_tool_run_state_resets_per_run(tmp_path, monkeypatch) -> None:
    workspace, guarded, calls = _guarded_document_tools(tmp_path, monkeypatch)
    payload = {"file_path": "book.xlsx", "sheet_name": "Data", "cell_range": "A1:B2"}

    guarded["inspect_document"].invoke(dict(payload))
    guarded["inspect_document"].invoke(dict(payload))
    assert json.loads(guarded["inspect_document"].invoke(dict(payload)))["errorCode"] == (
        LOOP_BREAK_ERROR_CODE
    )

    reset_document_tool_run_state(workspace.context)

    after_reset = json.loads(guarded["inspect_document"].invoke(dict(payload)))
    assert after_reset["status"] == "ok"
    # Cache was dropped with the signature history, so the tool ran again.
    assert len(calls) == 2


def test_non_retryable_errors_are_cached(tmp_path, monkeypatch) -> None:
    workspace, guarded, calls = _guarded_document_tools(tmp_path, monkeypatch)

    first = json.loads(guarded["inspect_document"].invoke({"file_path": "missing.xlsx"}))
    second = json.loads(guarded["inspect_document"].invoke({"file_path": "missing.xlsx"}))

    assert first["errorCode"] == "FILE_NOT_FOUND"
    assert second == first
    assert len(calls) == 1
