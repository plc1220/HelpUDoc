---
type: "system"
title: "Python agent service"
description: "The processing plane service responsible for extraction, analysis, and ML-driven tasks."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system%3Apython-agent-service"
tags: ["ml-services", "processing-plane"]
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
      block_ids: ["text-b35", "text-b36"]
  - id: "source-span-2"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b34", "text-b36"]
  - id: "source-span-3"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b33", "text-b34", "text-b35"]
---

# Python agent service

The processing plane service responsible for extraction, analysis, and ML-driven tasks.

## Relationships

* executes [Dynamic chunk planning](../procedure/dynamic-chunk-planning.md) _(extracted; confidence 1.00)_
* executes [Graph analysis and community detection](../procedure/graph-analysis-and-community-detection.md) _(extracted; confidence 1.00)_
* executes [Layout and heading analysis](../procedure/layout-and-heading-analysis.md) _(extracted; confidence 1.00)_
* executes [PDF/DOCX extraction](../procedure/pdf-docx-extraction.md) _(extracted; confidence 1.00)_
* executes [Query-time reranking](../procedure/query-time-reranking.md) _(extracted; confidence 1.00)_
* owns [Canonicalization candidates](../functionality/canonicalization-candidates.md) _(extracted; confidence 1.00)_
* owns [Dynamic chunk planning](../functionality/dynamic-chunk-planning.md) _(extracted; confidence 1.00)_
* owns [Gemini Lite structured extraction and reduction](../functionality/gemini-lite-structured-extraction-and-reduction.md) _(extracted; confidence 1.00)_
* owns [Graph analysis and community detection](../functionality/graph-analysis-and-community-detection.md) _(extracted; confidence 1.00)_
* owns [Layout and heading analysis](../functionality/layout-and-heading-analysis.md) _(extracted; confidence 1.00)_
* owns [PDF/DOCX extraction adapters](../functionality/pdf-docx-extraction-adapters.md) _(extracted; confidence 1.00)_
* owns [Query-time reranking and evidence selection](../functionality/query-time-reranking-and-evidence-selection.md) _(extracted; confidence 1.00)_
* owns [Validation helpers](../functionality/validation-helpers.md) _(extracted; confidence 1.00)_
* uses [Gemini Lite](../model/gemini-lite.md) _(extracted; confidence 1.00)_

[Read the original source](../../source.md)
