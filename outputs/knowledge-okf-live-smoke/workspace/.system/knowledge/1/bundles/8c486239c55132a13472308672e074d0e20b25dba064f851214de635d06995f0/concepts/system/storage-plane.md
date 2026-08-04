---
type: "system"
title: "Storage plane"
description: "The storage architecture supporting persistence and state management."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system%3Astorage-plane"
tags: ["infrastructure", "storage"]
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
      block_ids: ["text-b36", "text-b37"]
  - id: "source-span-2"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b33", "text-b37"]
  - id: "source-span-3"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b36", "text-b37", "text-b38"]
---

# Storage plane

The storage architecture supporting persistence and state management.

## Relationships

* integrates tracing with [Langfuse](langfuse.md) _(extracted; confidence 1.00)_
* manages tracing [Langfuse](langfuse.md) _(extracted; confidence 1.00)_
* persists semantic state in [PostgreSQL](postgresql.md) _(extracted; confidence 1.00)_
* stores coordination events [Redis Streams](redis-streams.md) _(extracted; confidence 1.00)_
* stores durable job state [PostgreSQL](../database/postgresql.md) _(extracted; confidence 1.00)_
* stores durable job state [PostgreSQL](postgresql.md) _(extracted; confidence 1.00)_
* stores embeddings [PostgreSQL](../database/postgresql.md) _(extracted; confidence 1.00)_
* stores embeddings [PostgreSQL (pgvector)](postgresql-pgvector.md) _(extracted; confidence 1.00)_
* stores file data [Original workspace file storage](../data-source/original-workspace-file-storage.md) _(extracted; confidence 1.00)_
* stores generated artifacts [Workspace storage](../storage/workspace-storage.md) _(extracted; confidence 1.00)_
* stores generated artifacts [Workspace Storage](workspace-storage.md) _(extracted; confidence 1.00)_
* stores original files [Workspace File Storage](workspace-file-storage.md) _(extracted; confidence 1.00)_
* stores progress events [Redis Streams](redis-streams.md) _(extracted; confidence 1.00)_
* supports graph traversal [Relational Adjacency Tables](relational-adjacency-tables.md) _(extracted; confidence 1.00)_
* uses for coordination [Redis Streams](redis-streams.md) _(extracted; confidence 1.00)_
* uses for tracing [Langfuse](langfuse.md) _(extracted; confidence 1.00)_

[Read the original source](../../source.md)
