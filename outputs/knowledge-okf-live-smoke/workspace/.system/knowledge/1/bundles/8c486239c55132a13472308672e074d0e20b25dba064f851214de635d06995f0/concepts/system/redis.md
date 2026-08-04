---
type: "System"
title: "Redis"
description: "Cache service for live progress events; not required for job recovery."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system%3Aredis"
tags: ["cache", "event-bus"]
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
      block_ids: ["text-b286", "text-b287"]
---

# Redis

Cache service for live progress events; not required for job recovery.

## Evidence-backed assertions

* Used for progress publication, but not as the durable source of truth. _(blocks text-b286, text-b287; confidence 1.00)_

[Read the original source](../../source.md)
