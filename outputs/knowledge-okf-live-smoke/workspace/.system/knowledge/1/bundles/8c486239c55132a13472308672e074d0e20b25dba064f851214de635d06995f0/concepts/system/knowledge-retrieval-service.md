---
type: "system"
title: "Knowledge Retrieval Service"
description: "A service responsible for retrieving knowledge, intended to replace legacy Markdown tree scans."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system%3Aknowledge-retrieval-service"
tags: ["API-gateway", "retrieval"]
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
      block_ids: ["text-b182", "text-b184"]
  - id: "source-span-2"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b182", "text-b183"]
---

# Knowledge Retrieval Service

A service responsible for retrieving knowledge, intended to replace legacy Markdown tree scans.

## Relationships

* exposes [knowledge_neighbors](../api/knowledge-neighbors.md) _(extracted; confidence 1.00)_
* exposes [knowledge_read](../api/knowledge-read.md) _(extracted; confidence 1.00)_
* exposes [knowledge_search](../api/knowledge-search.md) _(extracted; confidence 1.00)_
* exposes [rag_query](../api/rag-query.md) _(extracted; confidence 1.00)_

[Read the original source](../../source.md)
