---
type: "procedure"
title: "Query Flow Procedure"
description: "The sequential process for handling user inquiries, involving analysis, retrieval, fusion, expansion, filtering, and synthesis."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=procedure%3Aquery-flow-procedure"
tags: ["AI", "retrieval", "search"]
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
      block_ids: ["text-b158", "text-b159", "text-b160"]
  - id: "source-span-2"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b158"]
  - id: "source-span-3"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b158", "text-b160"]
---

# Query Flow Procedure

The sequential process for handling user inquiries, involving analysis, retrieval, fusion, expansion, filtering, and synthesis.

## Relationships

* executes parallel to [Lexical Retrieval](lexical-retrieval.md) _(extracted; confidence 1.00)_
* executes parallel to [Vector Retrieval](vector-retrieval.md) _(extracted; confidence 1.00)_
* merges results using [Reciprocal-rank Fusion](../method/reciprocal-rank-fusion.md) _(extracted; confidence 1.00)_
* performs bounded traversal [Graph Expansion](graph-expansion.md) _(extracted; confidence 1.00)_

[Read the original source](../../source.md)
