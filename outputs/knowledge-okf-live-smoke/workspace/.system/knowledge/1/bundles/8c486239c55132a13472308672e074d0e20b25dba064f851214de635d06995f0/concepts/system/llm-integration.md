---
type: "system"
title: "LLM Integration"
description: "LLM integration layer for AI-driven processing."
resource: "workspace-file://live-smoke/docs/architecture/knowledge-okf-enrichment-spec.md#concept=system%3Allm-integration"
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

# LLM Integration

LLM integration layer for AI-driven processing.

## Evidence-backed assertions

* Integrates Gemini Lite via ChatGoogleGenerativeAI for map/reduce and adjudication. _(blocks text-b188; confidence 1.00)_

## Relationships

* uses for structured output contracts [Pydantic](../technology/pydantic.md) _(extracted; confidence 1.00)_
* uses model [Gemini Lite](../technology/gemini-lite.md) _(extracted; confidence 1.00)_

[Read the original source](../../source.md)
