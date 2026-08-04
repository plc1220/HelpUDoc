---
type: "Policy"
title: "Snapshot Mutability Policy"
description: "Policy stating that changes to prompts, schemas, or models must create a new enrichment version rather than mutating existing snapshots."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=policy%3Asnapshot-mutability-policy"
tags: []
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
      block_ids: ["text-b205"]
---

# Snapshot Mutability Policy

Policy stating that changes to prompts, schemas, or models must create a new enrichment version rather than mutating existing snapshots.

## Relationships

* prohibits silent mutation of [Model-Assisted Output](../system/model-assisted-output.md) _(extracted; confidence 1.00)_

[Read the original source](../../source.md)
