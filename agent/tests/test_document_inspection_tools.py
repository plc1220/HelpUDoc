from __future__ import annotations

import json

from openpyxl import Workbook
from docx import Document

from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tools.workspace.builtins.document_inspection import (
    build_document_inspection_tools,
)
from helpudoc_agent.tools.workspace.builtins.knowledge_navigation import (
    build_knowledge_navigation_tools,
)


def test_document_tools_search_and_inspect_original_workbook(tmp_path) -> None:
    workbook_path = tmp_path / "forecast.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Forecast"
    sheet.append(["Region", "Revenue"])
    sheet.append(["Malaysia", 125000])
    sheet.append(["Singapore", 98000])
    workbook.save(workbook_path)

    workspace = WorkspaceState(workspace_id="docs", root_path=tmp_path)
    tools = {tool.name: tool for tool in build_document_inspection_tools(workspace)}

    inventory = json.loads(tools["inspect_document"].invoke({"file_path": "forecast.xlsx"}))
    assert inventory["file"] == "/forecast.xlsx"
    assert inventory["sheets"][0]["name"] == "Forecast"

    matches = json.loads(
        tools["search_document"].invoke(
            {"file_path": "forecast.xlsx", "query": "Malaysia"},
        )
    )
    assert matches["results"][0]["location"] == "sheet:Forecast:cell:A2"

    cells = json.loads(
        tools["inspect_document"].invoke(
            {
                "file_path": "forecast.xlsx",
                "sheet_name": "Forecast",
                "cell_range": "A1:B2",
            },
        )
    )
    assert cells["cells"][1][1]["value"] == 125000
    single_cell = json.loads(
        tools["inspect_document"].invoke(
            {
                "file_path": "forecast.xlsx",
                "sheet_name": "Forecast",
                "cell_range": "B2",
            },
        )
    )
    assert single_cell["cells"][0][0]["value"] == 125000

    oversized = tools["inspect_document"].invoke(
        {
            "file_path": "forecast.xlsx",
            "sheet_name": "Forecast",
            "cell_range": "A1:XFD1048576",
        },
    )
    assert oversized.startswith("Document inspection failed: Spreadsheet inspection range is too large")


def test_document_tools_keep_docx_search_locations_addressable(tmp_path) -> None:
    document_path = tmp_path / "policy.docx"
    document = Document()
    document.add_paragraph("")
    document.add_heading("Returns", level=1)
    document.add_paragraph("Customers have 30 days to return an item.")
    document.save(document_path)

    workspace = WorkspaceState(workspace_id="docs", root_path=tmp_path)
    tools = {tool.name: tool for tool in build_document_inspection_tools(workspace)}
    matches = json.loads(
        tools["search_document"].invoke({"file_path": "policy.docx", "query": "30 days"})
    )
    paragraph = matches["results"][0]["paragraph"]

    inspected = json.loads(
        tools["inspect_document"].invoke(
            {
                "file_path": "policy.docx",
                "item_start": paragraph,
                "item_end": paragraph,
            }
        )
    )
    assert inspected["selectedItems"][0]["index"] == paragraph
    assert "30 days" in inspected["selectedItems"][0]["text"]


def test_document_tools_reject_paths_outside_workspace(tmp_path) -> None:
    workspace = WorkspaceState(workspace_id="docs", root_path=tmp_path / "workspace")
    tool = {tool.name: tool for tool in build_document_inspection_tools(workspace)}["inspect_document"]

    result = tool.invoke({"file_path": "../secret.txt"})

    assert result.startswith("Document inspection failed: Path must remain inside the workspace")


def test_knowledge_tools_navigate_published_okf_bundle(tmp_path) -> None:
    bundle = tmp_path / ".system" / "knowledge" / "7"
    concepts = bundle / "concepts"
    concepts.mkdir(parents=True)
    (bundle / "index.md").write_text(
        "---\nokf_version: \"0.2\"\n---\n\n# Product Handbook\n\n"
        "* [Returns](concepts/returns.md) - Return policy\n",
        encoding="utf-8",
    )
    (concepts / "returns.md").write_text(
        "---\ntitle: \"Returns\"\n---\n\n# Returns\n\nCustomers have 30 days.\n",
        encoding="utf-8",
    )

    workspace = WorkspaceState(workspace_id="knowledge", root_path=tmp_path)
    workspace.context["knowledge_refs"] = [
        {"id": 7, "bundleRoot": str(bundle), "snapshotHash": "snapshot-7"}
    ]
    tools = {tool.name: tool for tool in build_knowledge_navigation_tools(workspace)}

    listing = json.loads(tools["knowledge_search"].invoke({"query": ""}))
    assert listing["results"][0]["path"] == "knowledge://7/index.md"

    search = json.loads(tools["knowledge_search"].invoke({"query": "30 days"}))
    assert search["results"][0]["path"] == "knowledge://7/concepts/returns.md"
    assert search["results"][0]["line"] == 7

    content = json.loads(
        tools["knowledge_read"].invoke(
            {
                "path": "knowledge://7/concepts/returns.md",
                "start_line": 7,
                "end_line": 7,
            }
        )
    )
    assert content["content"] == "Customers have 30 days."
    assert content["selectedLines"] == [7, 7]


def test_knowledge_tools_require_an_explicit_tagged_bundle(tmp_path) -> None:
    bundle = tmp_path / "standalone-bundle"
    bundle.mkdir()
    (bundle / "index.md").write_text("# Secret Knowledge\n", encoding="utf-8")
    workspace = WorkspaceState(workspace_id="knowledge", root_path=tmp_path)
    tools = {tool.name: tool for tool in build_knowledge_navigation_tools(workspace)}

    search = json.loads(tools["knowledge_search"].invoke({"query": "Secret"}))
    assert search["resultCount"] == 0
    assert "@ command" in search["message"]
    assert tools["knowledge_read"].invoke({"path": "knowledge://7/index.md"}).startswith(
        "Knowledge read failed: Knowledge bundle was not tagged"
    )
