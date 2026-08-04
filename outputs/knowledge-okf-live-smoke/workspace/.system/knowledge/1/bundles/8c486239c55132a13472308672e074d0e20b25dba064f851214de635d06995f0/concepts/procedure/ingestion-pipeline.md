---
type: "Procedure"
title: "Ingestion Pipeline"
description: "A sequence of stages to process and persist knowledge extraction results."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=procedure%3Aingestion-pipeline"
tags: ["ETL", "workflow"]
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
      block_ids: ["text-b165", "text-b168"]
---

# Ingestion Pipeline

A sequence of stages to process and persist knowledge extraction results.

## Relationships

* executes via [Knowledge Ingestion Tasks](../system/knowledge-ingestion-tasks.md) _(extracted; confidence 1.00)_
* managed by [Knowledge Ingestion Jobs](../system/knowledge-ingestion-jobs.md) _(extracted; confidence 1.00)_
* produces [Knowledge Snapshots](../system/knowledge-snapshots.md) _(extracted; confidence 1.00)_
* records metrics in [Knowledge Usage Events](../system/knowledge-usage-events.md) _(extracted; confidence 1.00)_

[Read the original source](../../source.md)
