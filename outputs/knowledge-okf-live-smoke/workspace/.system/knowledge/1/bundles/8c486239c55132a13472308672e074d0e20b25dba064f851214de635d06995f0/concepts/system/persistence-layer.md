---
type: "system"
title: "Persistence Layer"
description: "Persistence layer for jobs, concepts, evidence, and graph data."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system%3Apersistence-layer"
tags: ["tech-stack"]
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
      block_ids: ["text-b188"]
  - id: "source-span-2"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b188", "text-b190"]
---

# Persistence Layer

Persistence layer for jobs, concepts, evidence, and graph data.

## Evidence-backed assertions

* Uses PostgreSQL and Knex for data persistence. _(blocks text-b188; confidence 1.00)_

## Relationships

* uses [PostgreSQL](../technology/postgresql.md) _(extracted; confidence 1.00)_
* uses for embeddings [pgvector](../technology/pgvector.md) _(extracted; confidence 1.00)_
* uses for query building [Knex](../technology/knex.md) _(extracted; confidence 1.00)_

[Read the original source](../../source.md)
