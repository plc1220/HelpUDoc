from pathlib import Path

from helpudoc_agent.knowledge_ingestion.chunking import plan_windows
from helpudoc_agent.knowledge_ingestion.conversion import MarkItDownConversion, route_document
from helpudoc_agent.knowledge_ingestion.extractors import extract_blocks
from helpudoc_agent.knowledge_ingestion.enrichment import (
    CandidateAssertion,
    CandidateConcept,
    CandidateEvidence,
    WindowEnrichment,
    normalize_window_payload,
    prune_unsupported_evidence,
    validate_window_enrichment,
)
from helpudoc_agent.knowledge_ingestion.models import ProcessingWindow, SourceBlock
from helpudoc_agent.knowledge_ingestion.ocr import OcrBlock, OcrPageOutcome
from helpudoc_agent.knowledge_ingestion.graph import analyze_canonical_graph
from helpudoc_agent.knowledge_ingestion.structure import detect_structure
from helpudoc_agent.state import WorkspaceState
from helpudoc_agent.tools.workspace.builtins.knowledge_navigation import _selected_bundle_roots


def test_text_plan_has_complete_non_overlapping_core_ownership(tmp_path: Path) -> None:
    source = tmp_path / "handbook.md"
    source.write_text(
        "# Handbook\n\n## Renewal Policy\n\nCustomers provide notice.\n\n"
        "## Security\n\nAll access is reviewed.",
        encoding="utf-8",
    )
    blocks, manifest = extract_blocks(source)
    structure = detect_structure(source.name, blocks)
    windows = plan_windows(blocks, structure, target_tokens=20, hard_max_tokens=40)

    assert manifest.processedSourceUnits + manifest.failedSourceUnits == manifest.discoveredSourceUnits
    assert [block_id for window in windows for block_id in window.coreBlockIds] == [block.id for block in blocks]
    assert all(window.tokenCount <= 40 for window in windows)
    assert any(node.title == "Renewal Policy" for node in structure)


def test_pdf_empty_pages_remain_in_source_unit_accounting(tmp_path: Path) -> None:
    from pypdf import PdfWriter

    source = tmp_path / "blank.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.add_blank_page(width=612, height=792)
    with source.open("wb") as handle:
        writer.write(handle)

    _, manifest = extract_blocks(source)

    assert manifest.discoveredSourceUnits == 2
    assert manifest.processedSourceUnits == 0
    assert manifest.failedSourceUnits == 2
    assert manifest.needsOcrSourceUnits == 2
    assert [warning.sourceUnit for warning in manifest.warnings] == ["page:1", "page:2"]


def test_pdf_blank_page_is_processed_when_gemini_ocr_confirms_blank(tmp_path: Path) -> None:
    from pypdf import PdfWriter

    source = tmp_path / "blank.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    with source.open("wb") as handle:
        writer.write(handle)

    class BlankGeminiAdapter:
        name = "gemini-flash-lite"
        provider = "google"
        model = "gemini-flash-lite-test"
        mode = "auto"
        usage = []
        media_artifacts = []

        def recognize_pdf_page(self, _path: Path, _page: int) -> list[OcrBlock]:
            return []

        def page_outcome(self, _page: int) -> OcrPageOutcome:
            return OcrPageOutcome(status="completed", blank=True)

    blocks, manifest = extract_blocks(source, ocr_adapter=BlankGeminiAdapter())

    assert blocks == []
    assert manifest.processedSourceUnits == 1
    assert manifest.failedSourceUnits == 0
    assert manifest.needsOcrSourceUnits == 1
    assert manifest.ocrModel == "gemini-flash-lite-test"


def test_pdf_gemini_ocr_blocks_keep_heading_type_and_media_locator(tmp_path: Path) -> None:
    from pypdf import PdfWriter

    source = tmp_path / "scan.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    with source.open("wb") as handle:
        writer.write(handle)

    class GeminiAdapter:
        name = "gemini-flash-lite"
        provider = "google"
        model = "gemini-flash-lite-test"
        mode = "auto"
        usage = []
        media_artifacts = [{"id": "pdf-page:test#page=1", "page": 1}]

        def recognize_pdf_page(self, _path: Path, _page: int) -> list[OcrBlock]:
            return [OcrBlock(text="Little Bo-Peep", blockType="heading", headingLevel=1, confidence=0.99)]

        def page_outcome(self, _page: int) -> OcrPageOutcome:
            return OcrPageOutcome(status="completed")

    blocks, manifest = extract_blocks(source, ocr_adapter=GeminiAdapter())

    assert blocks[0].blockType == "heading"
    assert blocks[0].headingLevel == 1
    assert blocks[0].mediaArtifactId == "pdf-page:test#page=1"
    assert manifest.processedSourceUnits == 1


def test_networkx_graph_analysis_is_versioned_and_deterministic() -> None:
    concepts = [
        {"id": "person:bo-peep", "name": "Bo-Peep", "kind": "Person", "relationships": [
            {"targetId": "animal:sheep", "type": "searches_for", "confidence": 0.95},
        ]},
        {"id": "animal:sheep", "name": "Sheep", "kind": "Animal", "relationships": []},
        {"id": "theme:loss", "name": "Loss", "kind": "Theme", "relationships": []},
    ]

    first = analyze_canonical_graph(concepts)
    second = analyze_canonical_graph(concepts)

    assert first == second
    assert first["algorithm"] == "networkx-louvain"
    assert first["componentCount"] == 2
    assert first["orphanIds"] == ["theme:loss"]


def test_navigation_selects_only_the_explicitly_tagged_immutable_bundle(tmp_path: Path) -> None:
    root = tmp_path / ".system" / "knowledge"
    old_bundle = root / "7" / "bundles" / "old"
    new_bundle = root / "7" / "bundles" / "new"
    old_bundle.mkdir(parents=True)
    new_bundle.mkdir(parents=True)
    (old_bundle / "index.md").write_text("# Old", encoding="utf-8")
    (new_bundle / "index.md").write_text("# New", encoding="utf-8")
    (root / "7" / "current.json").write_text(
        '{"bundlePath":".system/knowledge/7/bundles/new","snapshotHash":"sha256:new"}',
        encoding="utf-8",
    )

    workspace = WorkspaceState(workspace_id="knowledge", root_path=tmp_path)
    workspace.context["knowledge_refs"] = [
        {"id": 7, "bundleRoot": str(new_bundle), "snapshotHash": "sha256:new"}
    ]

    assert _selected_bundle_roots(workspace) == [(new_bundle.resolve(), "sha256:new", 7)]


def test_map_validation_requires_core_span_evidence() -> None:
    blocks = [
        SourceBlock(
            id="b1", ordinal=0, text="Core evidence", blockType="paragraph",
            extractionMethod="native", extractionConfidence=1, contentHash="sha256:1",
        ),
        SourceBlock(
            id="b2", ordinal=1, text="Context only", blockType="paragraph",
            extractionMethod="native", extractionConfidence=1, contentHash="sha256:2",
        ),
    ]
    window = ProcessingWindow(
        id="window-1",
        structureNodeId="structure:root",
        coreBlockIds=["b1"],
        contextAfterBlockIds=["b2"],
        tokenCount=10,
        contentHash="sha256:window",
        strategy="structural",
    )
    invalid = WindowEnrichment(concepts=[CandidateConcept(
        candidateId="c1",
        kind="Policy",
        name="Renewal Policy",
        description="A policy.",
        assertions=[CandidateAssertion(
            text="Notice is required.",
            confidence=0.9,
            evidence=[CandidateEvidence(blockIds=["b2"])],
        )],
    )])
    valid = invalid.model_copy(deep=True)
    valid.concepts[0].assertions[0].evidence[0].blockIds = ["b1"]

    assert "has no core-span evidence" in validate_window_enrichment(invalid, window, blocks)[0]
    assert validate_window_enrichment(valid, window, blocks) == []

    pruned, warnings = prune_unsupported_evidence(invalid, window, blocks)
    assert pruned.concepts[0].assertions == []
    assert warnings == ["pruned c1 assertion 0: unsupported evidence"]
    assert validate_window_enrichment(pruned, window, blocks) == []


def test_map_payload_normalizes_relationship_types_from_vertex_function_calls() -> None:
    payload = {
        "concepts": [{
            "candidateId": "c1",
            "kind": "System",
            "name": "Publisher",
            "description": "Publishes a bundle.",
            "relationships": [{
                "targetName": "OKF Bundle",
                "targetKind": "Artifact",
                "type": "PART OF",
                "confidence": 0.9,
                "confidenceClass": "extracted",
                "evidenceBlockIds": ["b1"],
            }],
        }],
    }

    normalized = normalize_window_payload(payload)

    assert normalized["concepts"][0]["relationships"][0]["type"] == "part_of"
    assert normalized["concepts"][0]["relationships"][0]["confidenceClass"] == "EXTRACTED"


def test_oversize_block_is_forced_into_addressable_bounded_parts() -> None:
    block = SourceBlock(
        id="b1", ordinal=0, text="界" * 120, blockType="paragraph",
        extractionMethod="native", extractionConfidence=1, contentHash="sha256:large",
    )
    blocks = [block]
    structure = detect_structure("Large", blocks)

    windows = plan_windows(blocks, structure, target_tokens=20, hard_max_tokens=30)

    assert len(blocks) == 4
    assert [block_id for window in windows for block_id in window.coreBlockIds] == [block.id for block in blocks]
    assert all(window.strategy == "forced" for window in windows)
    assert all(window.tokenCount <= 30 for window in windows)


def test_markitdown_is_the_markdown_facade_while_native_blocks_keep_locators(tmp_path: Path) -> None:
    source = tmp_path / "handbook.md"
    source.write_text("# Native heading\n\nNative paragraph.", encoding="utf-8")

    routed = route_document(
        source,
        mode="primary",
        markitdown_converter=lambda _: MarkItDownConversion(
            markdown="# Normalized heading\n\nNormalized paragraph.",
            title="Normalized Handbook",
            converter="markitdown/test",
        ),
    )

    assert routed.title == "Normalized Handbook"
    assert routed.markdown.startswith("# Normalized heading")
    assert [block.text for block in routed.blocks] == ["Native heading", "Native paragraph."]
    assert routed.manifest.converter == "helpudoc-native/md"
    assert routed.manifest.markdownConverter == "markitdown/test"
    assert routed.manifest.locatorStrategy == "native-sidecar"


def test_markitdown_long_tail_format_gets_explicit_coarse_units(tmp_path: Path) -> None:
    source = tmp_path / "deck.pptx"
    source.write_bytes(b"fixture is routed by the injected converter")
    converted = """<!-- Slide number: 1 -->

# Introduction

First slide.

<!-- Slide number: 2 -->

# Architecture

Second slide.
"""

    routed = route_document(
        source,
        markitdown_converter=lambda _: MarkItDownConversion(
            markdown=converted,
            title="Deck",
            converter="markitdown/test",
        ),
    )

    assert routed.manifest.sourceType == "pptx"
    assert routed.manifest.discoveredSourceUnits == 2
    assert routed.manifest.locatorStrategy == "markdown-structural"
    assert {block.unit for block in routed.blocks} == {1, 2}
    assert {block.unitType for block in routed.blocks} == {"slide"}
    assert routed.blocks[0].blockType == "heading"


def test_markitdown_failure_is_visible_and_native_extraction_survives(tmp_path: Path) -> None:
    source = tmp_path / "notes.txt"
    source.write_text("Still available natively.", encoding="utf-8")

    def fail(_: Path) -> MarkItDownConversion:
        raise RuntimeError("converter unavailable")

    routed = route_document(source, markitdown_converter=fail)

    assert routed.blocks[0].text == "Still available natively."
    assert routed.manifest.warnings[0].code == "markitdown_fallback"
    assert "converter unavailable" in routed.manifest.warnings[0].message



def _small_pdf(path: Path, pages: int = 2) -> Path:
    import fitz  # type: ignore

    document = fitz.open()
    for index in range(pages):
        page = document.new_page()
        page.insert_text((72, 72), f"Section {index + 1}\n\nRenewal notice is required on page {index + 1}.")
    document.save(str(path))
    document.close()
    return path


def test_pdf_extraction_leaves_the_event_loop_free(tmp_path: Path, monkeypatch) -> None:
    """A large PDF must not freeze the agent's loop, or /health stops answering.

    The liveness probe then kills the agent and every in-flight ingestion job fails.
    Both synchronous extraction steps stand in here as sleeps; a heartbeat on the
    loop records the longest gap between its ticks.
    """
    import asyncio
    import time

    from helpudoc_agent.knowledge_ingestion import pipeline

    class FakeAdapter:
        mode = "auto"

        def __init__(self, **_kwargs) -> None:
            pass

        async def prepare_pdf(self, _path: Path, _targets: list[int]) -> None:
            return None

    def slow_targets(_path: Path, *, mode: str) -> list[int]:
        time.sleep(0.6)
        return [1]

    def slow_plan(_path: Path, **_kwargs) -> str:
        time.sleep(0.6)
        return "plan"

    monkeypatch.setenv("KNOWLEDGE_MARKITDOWN_MODE", "off")
    monkeypatch.setattr(pipeline, "GeminiFlashLiteOcrAdapter", FakeAdapter)
    monkeypatch.setattr(pipeline, "pdf_pages_requiring_ocr", slow_targets)
    monkeypatch.setattr(pipeline, "_build_plan", slow_plan)
    source = tmp_path / "large-report.pdf"
    source.write_bytes(b"%PDF-1.4\n")

    async def scenario() -> tuple[object, float]:
        longest_gap = 0.0
        done = asyncio.Event()

        async def heartbeat() -> None:
            nonlocal longest_gap
            last = time.perf_counter()
            while not done.is_set():
                await asyncio.sleep(0.02)
                now = time.perf_counter()
                longest_gap = max(longest_gap, now - last)
                last = now

        ticker = asyncio.create_task(heartbeat())
        # Let the heartbeat take its first reading; a freeze before then goes unseen.
        await asyncio.sleep(0.05)
        plan = await pipeline.extract_and_plan_document_with_gemini(source, client=object(), model="test")
        done.set()
        await ticker
        return plan, longest_gap

    plan, longest_gap = asyncio.run(scenario())

    assert plan == "plan"
    assert longest_gap < 0.3, f"event loop was blocked for {longest_gap:.2f}s"


def test_pymupdf_is_only_called_from_the_pymupdf_thread(tmp_path: Path, monkeypatch) -> None:
    """PyMuPDF documents that using it from more than one thread can crash Python."""
    import asyncio
    import threading

    import fitz  # type: ignore

    from helpudoc_agent.knowledge_ingestion import pipeline
    from helpudoc_agent.knowledge_ingestion.blocking import PYMUPDF_THREAD_NAME

    source = _small_pdf(tmp_path / "policy.pdf")
    original_open = fitz.open
    callers: list[str] = []

    def guarded_open(*args, **kwargs):
        callers.append(threading.current_thread().name)
        return original_open(*args, **kwargs)

    monkeypatch.setenv("KNOWLEDGE_MARKITDOWN_MODE", "off")
    monkeypatch.setattr(fitz, "open", guarded_open)

    plan = asyncio.run(
        pipeline.extract_and_plan_document_with_gemini(source, client=object(), model="test", ocr_mode="auto")
    )

    assert plan.blocks
    assert callers, "extraction never opened the PDF"
    assert all(name.startswith(PYMUPDF_THREAD_NAME) for name in callers), callers


def test_run_pymupdf_never_runs_two_calls_at_once() -> None:
    import asyncio
    import threading
    import time

    from helpudoc_agent.knowledge_ingestion.blocking import run_pymupdf

    active = 0
    peak = 0
    lock = threading.Lock()

    def work() -> None:
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.05)
        with lock:
            active -= 1

    async def scenario() -> None:
        await asyncio.gather(*(run_pymupdf(work) for _ in range(4)))

    asyncio.run(scenario())
    assert peak == 1


def test_markitdown_child_process_converts_a_local_file(tmp_path: Path) -> None:
    import asyncio

    from helpudoc_agent.knowledge_ingestion.markitdown_isolated import convert_with_markitdown_isolated

    source = tmp_path / "notes.md"
    source.write_text("# Notes\n\nNotice is required.", encoding="utf-8")

    conversion = asyncio.run(convert_with_markitdown_isolated(source, timeout_seconds=60))

    assert "Notice is required." in conversion.markdown
    assert conversion.converter.startswith("markitdown/")


def test_markitdown_child_process_is_killed_on_timeout(tmp_path: Path, monkeypatch) -> None:
    """An overrunning conversion must stop, not keep a CPU busy after the job gave up."""
    import asyncio
    import sys
    import time

    import pytest

    from helpudoc_agent.knowledge_ingestion import markitdown_isolated

    monkeypatch.setattr(
        markitdown_isolated,
        "_worker_command",
        lambda _path: [sys.executable, "-c", "import time; time.sleep(30)"],
    )
    started = time.perf_counter()
    with pytest.raises(TimeoutError, match="exceeded 0.5s"):
        asyncio.run(markitdown_isolated.convert_with_markitdown_isolated(tmp_path / "x.pdf", timeout_seconds=0.5))
    assert time.perf_counter() - started < 5


def test_markitdown_timeout_keeps_native_markdown_and_warns(tmp_path: Path, monkeypatch) -> None:
    """A slow MarkItDown pass must not fail the source; native extraction carries it."""
    import asyncio

    from helpudoc_agent.knowledge_ingestion import pipeline

    async def overrun(_path: Path, **_kwargs):
        raise TimeoutError("MarkItDown exceeded 120s")

    monkeypatch.setenv("KNOWLEDGE_MARKITDOWN_MODE", "primary")
    monkeypatch.setattr(pipeline, "convert_with_markitdown_isolated", overrun)
    source = _small_pdf(tmp_path / "report.pdf")

    plan = asyncio.run(
        pipeline.extract_and_plan_document_with_gemini(source, client=object(), model="test", ocr_mode="off")
    )

    assert "Renewal notice is required" in plan.markdown
    warnings = [warning for warning in plan.manifest.warnings if warning.code == "markitdown_fallback"]
    assert warnings and "MarkItDown exceeded 120s" in warnings[0].message
