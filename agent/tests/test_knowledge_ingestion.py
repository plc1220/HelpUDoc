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
from helpudoc_agent.tools.workspace.builtins.knowledge_navigation import _published_bundle_roots


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


def test_navigation_selects_only_the_current_immutable_bundle(tmp_path: Path) -> None:
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

    assert _published_bundle_roots(root) == [(new_bundle.resolve(), "sha256:new")]


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
