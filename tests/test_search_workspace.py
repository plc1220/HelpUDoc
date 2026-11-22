"""search_workspace and the per-run conversation archive.

Governance first (G2-G8 in the plan): an agent must never see another user's conversation,
or another conversation of the same user. The archive is bound to one run's task and the
tool takes no conversation, user or workspace argument.
"""
from __future__ import annotations

import asyncio
import json
import logging

import fitz  # PyMuPDF
import openpyxl
import pytest
from docx import Document

from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tools.workspace.builtins.conversation_archive import (
    FULL_MESSAGE_MAX_CHARS,
    MAX_ARCHIVE_CHARS,
    bind_run_conversation_archive,
    current_conversation_archive,
    parse_conversation_archive,
)
from helpudoc_agent.tools.workspace.builtins.document_inspection import build_search_workspace_tool


def _archive(conversation_id: str, *texts: str) -> dict:
    return {
        "conversationId": conversation_id,
        "truncated": False,
        "messages": [
            {"id": str(i), "role": "user" if i % 2 == 0 else "assistant", "createdAt": f"2026-11-16T0{i % 10}:00:00Z", "content": text}
            for i, text in enumerate(texts)
        ],
    }


def _workspace(tmp_path, skill: str = "managing_complaints"):
    state = WorkspaceState(workspace_id="ws", root_path=tmp_path / "ws")
    state.context.update({"active_skill": skill, "user_id": "alice"})
    state.root_path.mkdir(parents=True, exist_ok=True)
    return state


def _search(state, query: str) -> dict:
    tool = build_search_workspace_tool(state)
    return json.loads(tool.invoke({"query": query}))


# --- search_workspace over files and documents -----------------------------------------------

def test_finds_names_and_text_in_every_document_type(tmp_path):
    state = _workspace(tmp_path)
    root = state.root_path
    (root / "cases" / "CASE-26-000571").mkdir(parents=True)
    (root / "cases" / "CASE-26-000571" / "notes.md").write_text("intake notes")
    pdf = fitz.open(); pdf.new_page().insert_text((72, 72), "Complaint reference CASE-26-000571 about a card"); pdf.save(str(root / "complaint.pdf"))
    doc = Document(); doc.add_paragraph("Reply drafted for CASE-26-000571."); doc.save(str(root / "letter.docx"))
    wb = openpyxl.Workbook(); wb.active["B3"] = "CASE-26-000571"; wb.save(str(root / "register.xlsx"))

    result = _search(state, "CASE-26-000571")

    assert result["status"] == "ok"
    assert any("CASE-26-000571" in hit["file"] for hit in result["fileNameMatches"])
    files = {hit["file"] for hit in result["documentMatches"]}
    assert {"/complaint.pdf", "/letter.docx", "/register.xlsx"} <= files
    assert result["coverage"]["documentsSearched"] >= 4


def test_reports_what_it_could_not_search_and_says_to_ask(tmp_path):
    state = _workspace(tmp_path)
    (state.root_path / "image.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 64)
    (state.root_path / "image (2).png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 64)
    (state.root_path / "notes.txt").write_text("nothing relevant")

    result = _search(state, "CASE-26-000001")

    assert result["resultCount"] == 0
    assert result["coverage"]["notSearched"]["images"] == 2
    assert "imageNote" in result["coverage"]
    assert "request_clarification" in result["nextStep"]


def test_hidden_product_storage_is_never_searched(tmp_path):
    state = _workspace(tmp_path)
    versions = state.root_path / ".system" / "file-versions"
    versions.mkdir(parents=True)
    (versions / "case_CASE-26-000555.md").write_text("superseded CASE-26-000555")

    result = _search(state, "CASE-26-000555")

    assert result["resultCount"] == 0
    assert result["coverage"]["fileNamesSearched"] == 0


def test_structured_data_is_skipped_while_a_data_skill_runs(tmp_path):
    state = _workspace(tmp_path, skill="data/analyze")
    (state.root_path / "rows.csv").write_text("id,case\n1,CASE-26-000571\n")

    result = _search(state, "CASE-26-000571")

    assert result["documentMatches"] == []
    assert result["coverage"]["notSearched"]["structuredDataWhileDataSkillActive"] == 1


def test_empty_query_is_rejected(tmp_path):
    result = _search(_workspace(tmp_path), "   ")
    assert result["status"] == "error"


# --- conversation archive: content and limits ------------------------------------------------

def test_finds_case_details_pasted_earlier_in_the_conversation(tmp_path):
    state = _workspace(tmp_path)
    pasted = "Case CASE-26-000571: complainant reports an unauthorised BNPL charge of RM 1,250."
    bind_run_conversation_archive(_archive("conv-a", pasted, "Noted.", "Other case CASE-26-000001."))
    try:
        result = _search(state, "CASE-26-000571")
    finally:
        bind_run_conversation_archive(None)

    hits = result["conversationMatches"]
    assert len(hits) == 1 and hits[0]["text"] == pasted and hits[0]["complete"] is True
    assert result["coverage"]["earlierConversationMessagesSearched"] == 3


def test_large_messages_come_back_as_excerpts(tmp_path):
    state = _workspace(tmp_path)
    huge = "x" * (FULL_MESSAGE_MAX_CHARS + 10) + " CASE-26-000571 " + "y" * 5000
    bind_run_conversation_archive(_archive("conv-a", huge))
    try:
        hit = _search(state, "CASE-26-000571")["conversationMatches"][0]
    finally:
        bind_run_conversation_archive(None)

    assert hit["complete"] is False and "CASE-26-000571" in hit["text"] and len(hit["text"]) < 2000


def test_malformed_archive_payloads_give_no_archive():
    assert parse_conversation_archive(None) is None
    assert parse_conversation_archive({"messages": []}) is None  # no conversation id
    assert parse_conversation_archive({"conversationId": "c", "messages": "x"}) is None
    archive = parse_conversation_archive(
        {"conversationId": "c", "messages": [{"role": "system", "content": "x"}, {"role": "user", "content": "ok"}]}
    )
    assert [m.content for m in archive.messages] == ["ok"]  # unknown roles are dropped


def test_oversized_archive_keeps_the_newest_and_says_so():  # G8
    big = "z" * (MAX_ARCHIVE_CHARS // 2 + 10)
    archive = parse_conversation_archive(_archive("c", "oldest " + big, "middle " + big, "newest"))
    assert archive.truncated is True
    assert archive.messages[-1].content == "newest"
    assert all(not m.content.startswith("oldest") for m in archive.messages)


# --- governance invariants ---------------------------------------------------------------------

def test_no_archive_bound_means_no_conversation_search(tmp_path):  # G4
    bind_run_conversation_archive(None)
    result = _search(_workspace(tmp_path), "CASE-26-000571")
    assert result["conversationMatches"] == []
    assert result["coverage"]["earlierConversationMessagesSearched"] is None
    assert "conversationNote" in result["coverage"]


def test_concurrent_runs_each_see_only_their_own_conversation(tmp_path):  # G2, G3
    state = _workspace(tmp_path)
    tool = build_search_workspace_tool(state)

    async def run(conversation_id: str, secret: str, other_secret: str, barrier: asyncio.Barrier):
        bind_run_conversation_archive(_archive(conversation_id, f"{secret} details"))
        await barrier.wait()  # both runs bound before either searches
        own = json.loads(await asyncio.to_thread(tool.invoke, {"query": secret}))
        other = json.loads(await asyncio.to_thread(tool.invoke, {"query": other_secret}))
        return conversation_id, own["conversationMatches"], other["conversationMatches"], current_conversation_archive().conversation_id

    async def main():
        barrier = asyncio.Barrier(2)
        return await asyncio.gather(
            asyncio.create_task(run("conv-alice", "ALICE-CASE-1", "BOB-CASE-2", barrier)),
            asyncio.create_task(run("conv-bob", "BOB-CASE-2", "ALICE-CASE-1", barrier)),
        )

    for conversation_id, own, other, bound in asyncio.run(main()):
        assert bound == conversation_id
        assert len(own) == 1, f"{conversation_id} must find its own case"
        assert other == [], f"{conversation_id} must never see the other conversation"
    # Nothing leaks back to the caller's context after the runs.
    assert current_conversation_archive() is None


def test_sequential_runs_do_not_inherit_a_previous_archive(tmp_path):  # G3
    state = _workspace(tmp_path)
    tool = build_search_workspace_tool(state)

    async def run(archive):
        bind_run_conversation_archive(archive)
        return json.loads(await asyncio.to_thread(tool.invoke, {"query": "ALICE-CASE-1"}))["conversationMatches"]

    async def main():
        first = await asyncio.create_task(run(_archive("conv-a", "ALICE-CASE-1 data")))
        second = await asyncio.create_task(run(None))  # e.g. a resume, or another user's run
        third = await asyncio.create_task(run(_archive("conv-b", "unrelated")))
        return first, second, third

    first, second, third = asyncio.run(main())
    assert len(first) == 1 and second == [] and third == []


def test_the_model_cannot_point_the_search_at_another_conversation(tmp_path):  # G6
    tool = build_search_workspace_tool(_workspace(tmp_path))
    assert set(tool.args) == {"query", "max_results"}  # no conversation, user or workspace argument
    bind_run_conversation_archive(_archive("conv-a", "only alice's text"))
    try:
        result = json.loads(tool.invoke({"query": "conv-b conversationId=conv-b"}))
    finally:
        bind_run_conversation_archive(None)
    assert result["conversationMatches"] == []


def test_audit_log_has_no_message_content_or_query_text(tmp_path, caplog):  # G7
    state = _workspace(tmp_path)
    bind_run_conversation_archive(_archive("conv-a", "SECRET-COMPLAINT-TEXT CASE-26-000571"))
    try:
        with caplog.at_level(logging.INFO):
            _search(state, "CASE-26-000571")
    finally:
        bind_run_conversation_archive(None)
    records = [r for r in caplog.records if r.getMessage() == "Conversation archive searched"]
    assert len(records) == 1
    record = records[0]
    assert record.conversation_id == "conv-a" and record.user_id == "alice" and record.hits == 1
    assert record.query_chars == len("CASE-26-000571")
    rendered = record.getMessage() + json.dumps({k: str(v) for k, v in record.__dict__.items()})
    assert "SECRET-COMPLAINT-TEXT" not in rendered and "CASE-26-000571" not in rendered
