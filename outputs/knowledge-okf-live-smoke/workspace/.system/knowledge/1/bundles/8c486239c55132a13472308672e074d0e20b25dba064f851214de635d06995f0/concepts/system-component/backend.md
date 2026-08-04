---
type: "System Component"
title: "Backend"
description: "Backend infrastructure for data ingestion and orchestration."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system-component%3Abackend"
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
      block_ids: ["text-b257"]
---

# Backend

Backend infrastructure for data ingestion and orchestration.

## Relationships

* adopts [Durable Task Orchestration](../technology/durable-task-orchestration.md) _(extracted; confidence 1.00)_
* exposes [Progress/Report APIs](../api/progress-report-apis.md) _(extracted; confidence 1.00)_
* implements [Ingestion Migration](../procedure/ingestion-migration.md) _(extracted; confidence 1.00)_
* implements [Artifact Staging](artifact-staging.md) _(inferred; confidence 0.90)_

[Read the original source](../../source.md)
