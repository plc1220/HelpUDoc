---
type: "system"
title: "System Enrichment Pipeline"
description: "The technical architecture and operational procedures governing the enrichment pipeline."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system%3Asystem-enrichment-pipeline"
tags: ["data-pipeline", "infrastructure"]
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
      block_ids: ["text-b297", "text-b298"]
---

# System Enrichment Pipeline

The technical architecture and operational procedures governing the enrichment pipeline.

## Relationships

* schedules after snapshot [Deterministic Publication](../procedure/deterministic-publication.md) _(extracted; confidence 1.00)_
* serves as truth source [PostgreSQL](postgresql.md) _(extracted; confidence 1.00)_
* uses model [Gemini Lite](gemini-lite.md) _(extracted; confidence 1.00)_
* utilizes [Dynamic Chunking](../procedure/dynamic-chunking.md) _(extracted; confidence 1.00)_

[Read the original source](../../source.md)
