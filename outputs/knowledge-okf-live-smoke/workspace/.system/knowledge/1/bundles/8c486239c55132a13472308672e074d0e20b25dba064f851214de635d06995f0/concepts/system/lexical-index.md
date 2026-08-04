---
type: "System"
title: "Lexical Index"
description: "A data retrieval mechanism for storing and searching normalized concept data."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system%3Alexical-index"
tags: ["data-storage", "retrieval"]
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
      block_ids: ["text-b150"]
---

# Lexical Index

A data retrieval mechanism for storing and searching normalized concept data.

## Relationships

* uses engine [PostgreSQL](postgresql.md) _(extracted; confidence 1.00)_
* uses technique [Exact Phrase Search](../technique/exact-phrase-search.md) _(extracted; confidence 1.00)_
* uses technique [Full-Text Search](../technique/full-text-search.md) _(inferred; confidence 0.90)_
* uses technique [Trigram Search (pg_trgm)](../technique/trigram-search-pg-trgm.md) _(extracted; confidence 1.00)_

[Read the original source](../../source.md)
