---
type: "system"
title: "TypeScript Knowledge Worker"
description: "A dedicated worker process responsible for managing and processing knowledge enrichment tasks."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system%3Atypescript-knowledge-worker"
tags: ["backend", "typescript", "worker"]
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
      block_ids: ["text-b172", "text-b173"]
---

# TypeScript Knowledge Worker

A dedicated worker process responsible for managing and processing knowledge enrichment tasks.

## Relationships

* claims tasks from [PostgreSQL](postgresql.md) _(extracted; confidence 1.00)_
* uses for live progress [Redis](redis.md) _(extracted; confidence 1.00)_

[Read the original source](../../source.md)
