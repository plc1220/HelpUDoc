---
type: "system"
title: "PDF Extractor"
description: "A system or process for extracting content from PDF documents, specifically Stage 1: deterministic extraction."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system%3Apdf-extractor"
tags: ["deterministic", "extraction"]
status: active
generated:
  by: "helpudoc-enrichment/gemini-lite"
  at: "2026-08-04T00:00:00.000Z"
sources:
  - id: "source-span-1"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b46", "text-b48"]
  - id: "source-span-2"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b50"]
---

# PDF Extractor

A system or process for extracting content from PDF documents, specifically Stage 1: deterministic extraction.

## Relationships

* performs [Deterministic Extraction Process](../procedure/deterministic-extraction-process.md) _(extracted; confidence 1.00)_
* uses primary adapter [PyMuPDF](pymupdf.md) _(inferred; confidence 0.90)_
* uses secondary adapter [PyPDF](pypdf.md) _(inferred; confidence 0.90)_

[Read the original source](../../source.md)
