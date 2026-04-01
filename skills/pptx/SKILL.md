---
name: pptx
description: Handle slide decks and PowerPoint files cautiously; avoid binary reads, prefer companion PDFs or outlines for analysis, and be explicit about PPTX parsing limits.
tools:
  - request_clarification
---

# pptx

## Overview

Use this skill for `.pptx`, `.ppt`, and similar slide-deck files.

This skill prevents the agent from treating PowerPoint files as plain text and makes deck-analysis limits explicit.

## Rules

- Never call `read_file` on a raw `.pptx` or `.ppt`.
- Do not claim slide text, speaker notes, layouts, or embedded media were extracted unless a readable derivative exists.
- Prefer a companion PDF, Markdown outline, or pasted slide text when the user wants analysis.

## Workflow

1. Identify what the user actually needs.
   - Summarize an existing deck
   - Extract text from slides
   - Convert a PDF into slides
   - Edit or generate slide content

2. Pick the supported path.
   - If there is a companion PDF, use the `pdf` skill for analysis.
   - If there is a text outline or markdown version, use that as the source of truth.
   - If the task is about turning a PDF into slides, prefer the repo's paper-to-slides workflow rather than inspecting a PPTX binary.

3. Handle unsupported direct-reading cases.
   - If the only source is a `.pptx` and the user wants exact content inspection, explain that the current runtime does not natively parse PowerPoint binaries through the standard file tools.
   - Ask for one of:
     - exported PDF
     - slide outline in markdown or text
     - screenshots of the specific slides in question

4. Stay grounded.
   - Never infer slide count, notes, or exact bullet text from filename alone.
   - If the user only wants planning help for a deck, proceed using their brief without pretending the deck was parsed.

## Good uses

- Route deck summarization to a companion PDF
- Guide the user toward the right export for reliable analysis
- Support PDF-to-slides workflows without binary PPTX reads

## Avoid

- UTF-8 decoding of PowerPoint files
- Overstating what was extracted from an unreadable deck format
