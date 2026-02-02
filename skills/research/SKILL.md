---
name: research
description: Produce a sourced, long-form research report in the user's language.
tools:
  - google_search
source_skills:
  - research-core
  - research-sub_researcher
  - research-critique
---

# research

## Overview
Use this skill to research a topic and deliver a polished, well‑sourced report. The report must be written in the same language as the user.

## Workflow
1. **Record the question**
   - Write the original user question to `/question.txt`.

2. **Research**
   - Use `google_search` to gather sources and facts.
   - Target at least 8 distinct sources when possible; if fewer are available, note the limitation.

3. **Write or update the report file**
   - If the user specifies a file, edit that file.
   - Otherwise, create a new kebab‑case Markdown file in the workspace root (e.g., `space-data-centers.md`).

4. **Deliver the report**
   - Respond with the full report content (not a summary) so the user can read it in chat.

## Report requirements
- Use clear Markdown headings (`#`, `##`, `###`).
- Aim for 1500–2500 words unless the topic is narrow.
- Each major section should include at least two multi‑sentence paragraphs.
- Use simple, professional language and avoid self‑referential commentary.
- Do not explain what you are doing; just write the report.

## Structure guidance (examples)
- **Compare two things:** Intro → Topic A → Topic B → Comparison → Conclusion.
- **List items:** A single list section, or one section per item; no intro/conclusion required.
- **Overview/summary:** Overview → Key concept 1 → Key concept 2 → Key concept 3 → Conclusion.
- **Single‑section answer:** Use one cohesive section if it fully answers the prompt.

## Citations & sources
- When referencing a source in the text, use `[Title](URL)` format where possible.
- Also include numeric citations `[1]`, `[2]`, ... tied to the source list below.
- End with `### Sources` and list each source on its own line:
  - `[1] Source Title: URL`
  - `[2] Source Title: URL`
- Number sequentially with no gaps.
