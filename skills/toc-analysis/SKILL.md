---
name: toc-analysis
description: Analyze a document table of contents or outline to infer structure, coverage, gaps, and recommended improvements before deeper reading or drafting.
tools:
  - rag_query
  - request_clarification
---

# toc-analysis

## Overview

Use this skill when the user asks to analyze, improve, compare, or reason from a table of contents, outline, syllabus, report structure, proposal structure, slide agenda, or chapter list.

This skill focuses on structure before prose: hierarchy, sequencing, coverage, balance, missing sections, duplicated ideas, and whether the outline matches the user's goal.

## Rules

- Treat the table of contents as structural evidence, not proof of the full document's content.
- If the user provides a document but no visible TOC, use `rag_query` to locate headings, sections, or outline-like content.
- If the target document or goal is unclear, call `request_clarification`.
- Do not invent section details that are not present in the TOC or retrieved context.
- Keep recommendations concrete and tied to named sections.
- Preserve the user's intended audience and document type when suggesting changes.

## Workflow

1. Identify the source and goal.
   - Confirm whether the user wants critique, summary, restructuring, gap analysis, comparison, or drafting help.
   - Identify the target audience and purpose when the user provides them.

2. Extract the outline.
   - Use the user-provided TOC directly when available.
   - If the TOC is in a workspace document, call `rag_query` for headings, section titles, and outline structure.
   - Keep section order and hierarchy intact.

3. Analyze structure.
   - Identify major parts, section depth, ordering, and transitions.
   - Note overlong, underdeveloped, duplicated, or misplaced sections.
   - Check whether prerequisites appear before advanced material.
   - Check whether evidence, methodology, conclusions, and next steps are present when appropriate.

4. Evaluate fit for purpose.
   - For research reports, check for scope, methodology, findings, synthesis, limitations, and sources.
   - For proposals, check for problem, context, solution, delivery plan, risks, timeline, and commercial terms.
   - For educational material, check for learning objectives, conceptual progression, examples, practice, and assessment.
   - For slide decks, check for narrative arc, decision points, appendix placement, and executive readability.

5. Respond with a concise structural review.
   - Start with the overall read on the TOC.
   - List the strongest structural choices.
   - List gaps or risks tied to specific sections.
   - Provide a revised outline when the user asks for improvements.
   - Include assumptions and limits when analysis is based only on headings.

## Good uses

- "Analyze this report TOC and tell me what's missing."
- "Does this proposal outline flow well for an enterprise buyer?"
- "Compare these two chapter outlines."
- "Turn this rough section list into a stronger table of contents."
- "Find gaps in the structure of this uploaded PDF."

## Avoid

- Claiming you reviewed full section content from headings alone.
- Rewriting the entire document unless the user asks.
- Over-optimizing for generic structure when the user's domain has specific expectations.
