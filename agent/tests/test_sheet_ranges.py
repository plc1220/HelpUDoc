"""A sheet range too large for one result must be readable in steps, without gaps or rereading."""
from __future__ import annotations

import json
from types import SimpleNamespace

import openpyxl
import pytest

from helpudoc_agent.tools.workspace.builtins import document_inspection as di


@pytest.fixture()
def inspect(tmp_path):
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = "Data"
    for row in range(1, 156):
        sheet.append([f"r{row}c{col} " + "text " * 5 for col in range(1, 10)])
    book.save(tmp_path / "book.xlsx")
    tool = di.build_inspect_document_tool(SimpleNamespace(root_path=tmp_path, context={}, workspace_id="w"))

    def call(cell_range):
        return tool.invoke({"file_path": "book.xlsx", "sheet_name": "Data", "cell_range": cell_range})

    return call


def test_a_large_range_is_read_in_steps_with_every_cell_once(inspect):
    seen, target, calls = [], "A1:I155", 0
    while target:
        text = inspect(target)
        assert len(text) <= di._MAX_OUTPUT_CHARS
        result = json.loads(text)
        assert result["status"] == "ok" and result["selectedRange"] == target
        seen += [cell["cell"] for row in result["cells"] for cell in row]
        target = result.get("nextRange")
        assert bool(target) == bool(result.get("outputTruncated"))
        calls += 1
    assert len(seen) == len(set(seen)) == 155 * 9 and calls <= 6


def test_a_range_that_fits_is_unchanged(inspect):
    text = inspect("A1:C3")
    result = json.loads(text)
    assert "nextRange" not in result and "outputTruncated" not in result
    assert text == json.dumps(result, ensure_ascii=False, indent=2)


def test_one_huge_row_still_returns(inspect, monkeypatch):
    monkeypatch.setattr(di, "_MAX_OUTPUT_CHARS", 300)
    assert len(inspect("A1:I1")) < 400 and len(inspect("A1:I3")) < 400
