"""read_file must not return whole PDF and Office documents.

It returned them as base64. A 9 MB case PDF became 9.2M characters, LangChain's token
estimate counted ~2.3M tokens, SummarizationMiddleware fired, and the run lost the
user's question and ended with an empty reply. Documents go
through search_document / inspect_document instead. Images and small scanned PDFs, which
those tools cannot read, still come back from read_file.
"""
from __future__ import annotations

import os

import fitz  # PyMuPDF
import pytest

from helpudoc_agent.runtime.agent_registry import (
    _READ_FILE_SCANNED_PDF_MAX_BYTES,
    SkillScopedFilesystemBackend,
)
from helpudoc_agent.state import WorkspaceState


def _backend(tmp_path):
    state = WorkspaceState(workspace_id="ws", root_path=tmp_path / "ws")
    state.context.update({"active_skill": "managing_complaints", "user_id": "alice"})
    state.root_path.mkdir(parents=True, exist_ok=True)
    return state.root_path, SkillScopedFilesystemBackend(
        workspace_state=state, root_dir=str(state.root_path), virtual_mode=True
    )


def _text_pdf(path, pages=2):
    doc = fitz.open()
    for number in range(pages):
        doc.new_page().insert_text((72, 72), f"Complaint page {number + 1}: the customer reports an unauthorised transaction.")
    doc.save(str(path))


def _scanned_pdf(path, noise_bytes):
    # A page that is only an image: no text layer. Random pixels do not compress, so the
    # file size follows noise_bytes.
    side = int((noise_bytes / 3) ** 0.5) + 1
    pixmap = fitz.Pixmap(fitz.csRGB, side, side, os.urandom(side * side * 3), 0)
    doc = fitz.open()
    page = doc.new_page()
    page.insert_image(page.rect, pixmap=pixmap)
    doc.save(str(path), deflate=False)


def test_pdf_with_text_is_routed_to_the_document_tools(tmp_path):
    root, backend = _backend(tmp_path)
    _text_pdf(root / "case.pdf")

    result = backend.read("/case.pdf")

    assert result.file_data is None
    assert "search_document" in result.error and "inspect_document" in result.error
    assert "case.pdf" in result.error


@pytest.mark.parametrize("name", ["mapping.xlsx", "macro.xlsm", "letter.docx", "deck.pptx"])
def test_office_documents_are_routed_to_the_document_tools(tmp_path, name):
    root, backend = _backend(tmp_path)
    (root / name).write_bytes(b"PK\x03\x04" + os.urandom(2048))

    result = backend.read(f"/{name}")

    assert result.file_data is None
    assert "search_document" in result.error


def test_small_scanned_pdf_is_still_returned_for_visual_reading(tmp_path):
    root, backend = _backend(tmp_path)
    _scanned_pdf(root / "scan.pdf", noise_bytes=120_000)
    assert (root / "scan.pdf").stat().st_size <= _READ_FILE_SCANNED_PDF_MAX_BYTES

    result = backend.read("/scan.pdf")

    assert result.error is None
    assert result.file_data["encoding"] == "base64"


def test_large_scanned_pdf_gets_guidance_instead_of_megabytes(tmp_path):
    root, backend = _backend(tmp_path)
    _scanned_pdf(root / "big-scan.pdf", noise_bytes=1_500_000)
    assert (root / "big-scan.pdf").stat().st_size > _READ_FILE_SCANNED_PDF_MAX_BYTES

    result = backend.read("/big-scan.pdf")

    assert result.file_data is None
    assert "scanned PDF" in result.error and "ask the user" in result.error


def test_images_and_text_files_are_unchanged(tmp_path):
    root, backend = _backend(tmp_path)
    (root / "screenshot.png").write_bytes(b"\x89PNG\r\n\x1a\n" + os.urandom(4096))
    (root / "notes.md").write_text("line one\nline two\n")

    image = backend.read("/screenshot.png")
    text = backend.read("/notes.md")

    assert image.error is None and image.file_data["encoding"] == "base64"
    assert text.error is None and text.file_data["content"].startswith("line one")


def test_a_missing_pdf_is_still_reported_as_missing(tmp_path):
    _, backend = _backend(tmp_path)

    result = backend.read("/nowhere.pdf")

    assert result.file_data is None
    assert "not found" in result.error


@pytest.mark.asyncio
async def test_the_async_read_path_is_routed_too(tmp_path):
    root, backend = _backend(tmp_path)
    _text_pdf(root / "case.pdf")

    result = await backend.aread("/case.pdf")

    assert result.file_data is None and "search_document" in result.error
