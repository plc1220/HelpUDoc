---
name: docx
description: Work with Microsoft Word DOCX files safely. Use when the user asks to inspect, compare, revise, polish, generate, or prepare Word documents, especially SOWs and proposals that need consistent DOCX-ready structure.
tools:
  - rag_query
  - request_clarification
---

# docx

## Overview

Use this skill for `.docx` and `.doc` files. Word files are binary OOXML, so the agent should not treat them as plain UTF-8 text. This skill keeps document work grounded and gives proposal-writing a consistent DOCX-ready output contract.

## Rules

- Never call `read_file` on a raw `.docx` or `.doc`.
- Prefer indexed document text, derived artifacts, or explicit user-provided excerpts for content inspection.
- If the user provides a DOCX as a style example, extract the structure and writing patterns, not just the topic.
- Do not claim exact Word pagination, headers, footers, comments, tracked changes, or visual layout unless a renderer or DOCX-specific tool confirms them.
- For generated documents, keep markdown as the canonical editable source unless a DOCX export tool is explicitly available.
- If the task is a proposal, SOW, commercial proposal, RFP response, or customer-facing scope document, load `proposal-writing` and follow its revision and DOCX-ready rules.

## Workflow

1. Determine the DOCX task type.
   - Content question or summary
   - Style/template extraction
   - Comparison between two documents
   - Proposal/SOW revision
   - New DOCX-ready document generation

2. Inspect safely.
   - If the DOCX is indexed, use `rag_query` against the concrete file path.
   - If a derived markdown/text preview exists, use that as the readable source.
   - If the document is not indexed and no derived artifact exists, ask for an exported PDF/text version or use another available DOCX-aware tool if present.

3. Extract structure when using a DOCX as a template.
   Capture:
   - title block fields
   - heading hierarchy
   - recurring tables
   - signature blocks
   - assumptions / exclusions / acceptance criteria patterns
   - level of detail and commercial tone

4. For proposal/SOW output.
   - Use `proposal-writing`.
   - Produce `/Final_Proposal.md` as the canonical source.
   - Make it DOCX-ready with clean numbered headings, tables, plain bullets, and signature blocks.
   - Do not append revised content after old content; rewrite affected sections and rebuild the final document.

5. For exact DOCX output.
   - If a DOCX export/edit tool is available, use it after the markdown source is verified.
   - If no DOCX export/edit tool is available, state that the workspace has a DOCX-ready markdown source and identify any export limitation.

## Good uses

- Compare a polished SOW DOCX against a weaker generated proposal.
- Pull heading structure and table patterns from a Word proposal.
- Prepare a proposal in markdown that can be exported cleanly to Word.
- Explain likely limitations when Word layout fidelity matters.

## Avoid

- UTF-8 decoding Word binaries.
- Appending "improved" material after an existing document instead of revising it.
- Treating a DOCX preview as exact Microsoft Word layout.
