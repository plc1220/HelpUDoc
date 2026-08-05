---
type: "system"
title: "PostgreSQL"
description: "Database system used for storing runtime indexes derived from the OKF bundle."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system%3Apostgresql"
tags: ["database", "infrastructure", "queue"]
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
      block_ids: ["text-b165", "text-b166", "text-b172"]
  - id: "source-span-2"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b172", "text-b173"]
  - id: "source-span-3"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b295", "text-b297"]
---

# PostgreSQL

Database system used for storing runtime indexes derived from the OKF bundle.

## Relationships

* claim tasks [Knowledge Worker](knowledge-worker.md) _(extracted; confidence 1.00)_
* manages task queue for [TypeScript Knowledge Worker](typescript-knowledge-worker.md) _(extracted; confidence 1.00)_
* serves as [semantic-state-store](semantic-state-store.md) _(extracted; confidence 1.00)_

[Read the original source](../../source.md)
