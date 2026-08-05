---
type: "System"
title: "HelpUDoc"
description: "The document processing and retrieval platform designed to turn uploaded documents into semantically organized knowledge sources."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system%3Ahelpudoc"
tags: ["AI-agent", "core-system", "knowledge-management"]
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
      block_ids: ["text-b2"]
  - id: "source-span-2"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b4"]
  - id: "source-span-3"
    resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md"
    title: "knowledge-okf-enrichment-spec.md"
    locator:
      kind: "source_blocks"
      block_ids: ["text-b8"]
---

# HelpUDoc

The document processing and retrieval platform designed to turn uploaded documents into semantically organized knowledge sources.

## Relationships

* depends on [Redis](../cache/redis.md) _(extracted; confidence 1.00)_
* depends on [PostgreSQL](../database/postgresql.md) _(extracted; confidence 1.00)_
* implements [Semantic Enrichment Pipeline](../concept/semantic-enrichment-pipeline.md) _(extracted; confidence 1.00)_
* includes component [Agent](../system-component/agent.md) _(extracted; confidence 1.00)_
* includes component [Backend](../system-component/backend.md) _(extracted; confidence 1.00)_
* includes component [Frontend](../system-component/frontend.md) _(extracted; confidence 1.00)_
* produces [OKF bundle](../artifact/okf-bundle.md) _(extracted; confidence 0.90)_

[Read the original source](../../source.md)
