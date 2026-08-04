---
type: "system"
title: "Gemini Lite"
description: "The LLM model configured to perform entity extraction and semantic analysis within the new pipeline."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system%3Agemini-lite"
tags: ["AI", "ai-agent", "ai-model", "boundary-detection", "model"]
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
      block_ids: ["text-b196", "text-b198"]
  - id: "source-span-2"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b200", "text-b201"]
  - id: "source-span-3"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b7"]
  - id: "source-span-4"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b198", "text-b199"]
  - id: "source-span-5"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b295", "text-b297"]
  - id: "source-span-6"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b86"]
---

# Gemini Lite

The LLM model configured to perform entity extraction and semantic analysis within the new pipeline.

## Evidence-backed assertions

* Gemini Lite is a model used within the system methodology. _(blocks text-b196, text-b198; confidence 1.00)_

## Relationships

* does not perform [System infrastructure decisions](../procedure/system-infrastructure-decisions.md) _(extracted; confidence 1.00)_
* is used by [Semantic Enrichment Pipeline](../procedure/semantic-enrichment-pipeline.md) _(extracted; confidence 1.00)_
* performs [Community naming](../procedure/community-naming.md) _(extracted; confidence 1.00)_
* performs [enrichment-process](../procedure/enrichment-process.md) _(extracted; confidence 1.00)_
* performs [Leaf semantic extraction](../procedure/leaf-semantic-extraction.md) _(extracted; confidence 1.00)_
* performs [Low-confidence alias adjudication](../procedure/low-confidence-alias-adjudication.md) _(extracted; confidence 1.00)_
* performs [Low-confidence structural boundary adjudication](../procedure/low-confidence-structural-boundary-adjudication.md) _(extracted; confidence 1.00)_
* performs [Optional top-candidate reranking](../procedure/optional-top-candidate-reranking.md) _(extracted; confidence 1.00)_
* performs [Section and document reductions](../procedure/section-and-document-reductions.md) _(extracted; confidence 1.00)_
* performs adjudication for [Semantic Fallback Boundaries System](semantic-fallback-boundaries-system.md) _(extracted; confidence 1.00)_

[Read the original source](../../source.md)
