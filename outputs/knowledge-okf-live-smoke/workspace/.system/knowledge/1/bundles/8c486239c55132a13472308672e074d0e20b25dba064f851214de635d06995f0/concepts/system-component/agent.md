---
type: "System Component"
title: "Agent"
description: "Agent logic responsible for document processing, extraction, and planning."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system-component%3Aagent"
tags: ["agent", "data-processing"]
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
      block_ids: ["text-b259"]
---

# Agent

Agent logic responsible for document processing, extraction, and planning.

## Relationships

* creates [helpudoc_agent/knowledge_ingestion](../software-module/helpudoc-agent-knowledge-ingestion.md) _(extracted; confidence 1.00)_
* implements [Source-specific Test Fixtures](../testing-tool/source-specific-test-fixtures.md) _(extracted; confidence 1.00)_
* integrates [PyMuPDF and OCR Adapters](../technology/pymupdf-and-ocr-adapters.md) _(extracted; confidence 1.00)_

[Read the original source](../../source.md)
