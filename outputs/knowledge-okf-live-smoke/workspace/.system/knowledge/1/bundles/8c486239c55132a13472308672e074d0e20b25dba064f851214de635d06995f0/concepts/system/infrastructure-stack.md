---
type: "System"
title: "Infrastructure Stack"
description: "The underlying technologies used for data storage, processing, and management within the pipeline."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system%3Ainfrastructure-stack"
tags: ["backend", "infrastructure"]
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
      block_ids: ["text-b37", "text-b43"]
---

# Infrastructure Stack

The underlying technologies used for data storage, processing, and management within the pipeline.

## Relationships

* uses for coordination [Redis Streams](redis-streams.md) _(extracted; confidence 1.00)_
* uses for durable state [PostgreSQL](postgresql.md) _(extracted; confidence 1.00)_
* uses for tracing [Langfuse](langfuse.md) _(extracted; confidence 1.00)_

[Read the original source](../../source.md)
