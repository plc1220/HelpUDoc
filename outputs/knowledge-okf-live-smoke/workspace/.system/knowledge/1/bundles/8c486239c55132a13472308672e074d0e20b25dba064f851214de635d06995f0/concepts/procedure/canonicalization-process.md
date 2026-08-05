---
type: "Procedure"
title: "Canonicalization Process"
description: "The process of consolidating entity candidates into a single canonical representation using various validation signals."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=procedure%3Acanonicalization-process"
tags: []
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
      block_ids: ["text-b112", "text-b113", "text-b114"]
  - id: "source-span-2"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b112", "text-b115", "text-b116"]
  - id: "source-span-3"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b112", "text-b117"]
---

# Canonicalization Process

The process of consolidating entity candidates into a single canonical representation using various validation signals.

## Evidence-backed assertions

* Canonicalization uses deterministic and model-assisted methods to merge entities. _(blocks text-b112, text-b113, text-b114; confidence 1.00)_
* Every merge decision must record metadata including candidate IDs, canonical ID, method, confidence, and provenance. _(blocks text-b112, text-b115, text-b116; confidence 1.00)_
* The system must not force merges; low-confidence matches remain separate. _(blocks text-b112, text-b117; confidence 1.00)_

[Read the original source](../../source.md)
