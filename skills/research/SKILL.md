---
name: research
description: Produce a sourced, long-form research report in the user's language, using a structured plan, evidence notes, and synthesis before consolidation.
tools:
  - google_search
  - request_plan_approval
source_skills:
  - research-core
  - research-sub_researcher
  - research-critique
---

# research

## Overview
Use this skill to research a topic and deliver a structured, well‑sourced report in the same language as the user.

This skill emphasizes:
- Evidence grounding before writing
- Structured note capture
- Cross‑source synthesis
- Explicit citation discipline
- Failure transparency when evidence is limited

## Output rules (strict)
- Write all report content to Markdown files in the workspace.
- Do NOT paste the full report in chat.
- In chat, provide only:
  - The research plan
  - Short progress updates (1–3 sentences)
  - Final confirmation with file path(s)
- Each major section must be written as a separate Markdown file before consolidation.
- Generate a Mermaid knowledge graph before final stitching.
- The final consolidated report must be 1500–2500 words unless the topic is clearly narrow.
- Do not summarize the report in chat unless explicitly requested.

## Workflow
1. **Record the question**
   - Write the original user question to `/question.txt`.

2. **Preliminary search (limited, before plan approval)**
   - Run `google_search` 2–3 times to capture the latest developments before drafting the plan.
   - Keep this stage lightweight and exploratory.
   - Record key findings in `/preliminary_search_notes.md`.
   - Explicitly anchor findings to the latest available timeline (current year/month/day where relevant).
   - Use these findings to improve scope, key questions, and section outline.
   - Do not run broad evidence gathering in this stage.

3. **Draft and share research plan**
   - Create `/research_plan.md` including:
     - Scope definition
     - Key research questions
     - Topic classification (Descriptive / Comparative / Policy / Historical / Predictive / Technical)
     - Tentative source types (news, academic, government, industry, etc.)
     - Proposed section outline
     - Known uncertainties or ambiguity
   - Call `request_plan_approval` with:
     - `plan_title`
     - `plan_summary`
     - `execution_checklist`
     - `risky_actions` (optional)
      - `reviewer_feedback` (optional; use when editing a previously proposed plan)
   - A limited pre-plan search (2–3 calls) is allowed before approval, but the main evidence gathering must wait for approval.
   - If decision is `edit`, update `/research_plan.md` and call `request_plan_approval` again for final approval.
   - If decision is `reject`, stop execution.
   - Do not continue the full research workflow before plan approval.

4. **Evidence gathering**
   - Use `google_search` to collect sources.
   - Prioritize the most recent primary sources first and always confirm timeline-sensitive facts against latest available dates.
   - Target at least 8 distinct credible sources when possible.
   - Prioritize academic journals, government publications, major news outlets, and primary documents.
   - Avoid low‑quality SEO content or unsourced blogs.
   - If fewer than 5 credible sources are found, explicitly note this limitation in the report.

5. **Structured research notes (mandatory)**
   - Create `/research_notes.md` including:
     - Key claims per source
     - Key statistics
     - Important quotes (if relevant)
     - Conflicting claims
     - Open questions or evidence gaps
   - No prose writing should begin before this file is created.

6. **Write each section as a standalone file**
   - Use zero‑padded filenames: `/01_tldr.md`, `/02_scope.md`, `/03_methodology.md`, `/04_background.md`, etc.
   - Each major section must contain at least 250–400 words (unless clearly narrow).
   - Each section must include at least one explicit claim supported by citation.
   - Data, statistics, and dated events must always include numeric citation.
   - Avoid purely descriptive writing; emphasize analysis.
   - If a section file exists, edit rather than overwrite.

7. **Create knowledge graph**
   - Generate `/knowledge_graph.md` with Mermaid:
     - Use `graph TD` or `graph LR`
     - Include at least 5 entities
     - Include at least 5 labeled relationships
     - Use meaningful edge labels (e.g., "regulates", "funds", "influences", "competes with")
     - Reflect causal or structural relationships, not just grouping

8. **Cross‑source synthesis (required)**
   - Create `/synthesis.md` including:
     - Patterns across sources
     - Agreements
     - Disagreements
     - Gaps in evidence
     - Areas of uncertainty
   - This file must exist before consolidation.

9. **Consolidate final report**
   - Stitch sections in outline order into a final report file.
   - If the user specifies a filename, use that. Otherwise create a new kebab‑case file at workspace root.
   - Build the final report from the existing section files and synthesis files on disk (do not rewrite from memory only).
   - Preserve section substance from `/01_*.md`, `/02_*.md`, etc.; avoid shortening due to context window pressure.
   - If needed, consolidate in multiple passes and verify the final report still includes all core section content.
   - The final report must include:
     - Clear Markdown headings
     - Numeric citations `[1]`, `[2]`, ...
     - Inline links when possible
     - Word count at bottom (not shown in chat)
     - A final `### Sources` section listing all sources

## Default structure (adaptive)
Unless clearly inappropriate, include:
- TL;DR
- Scope & Research Questions
- Methodology & Sources
- Background & Definitions
- Findings (longest section)
- Case Studies (if multi‑actor)
- Comparative Analysis (if relevant)
- Implications & Risks
- Scenarios / Outlook
- Conclusion
- Sources

Adjust based on topic classification.

## Citation rules
- Every factual claim involving data must include a numeric citation.
- Do not cite the same source more than 3 times unless essential.
- If multiple sources support a major claim, cite at least two.
- Number citations sequentially with no gaps.
- End with:
  - `### Sources`
  - `[1] Source Title: URL`
  - `[2] Source Title: URL`
  - ...

## Failure handling
- If evidence is limited, include a **Limits of Evidence** section.
- If sources conflict, include a **Conflicting Evidence** subsection.
- If topic is speculative or emerging, state that clearly.
- Never fabricate missing data to meet word count.

## Evidence integrity requirement
For policy, economics, strategy, or scientific topics, include:
- Alternative interpretations
- What evidence would falsify the dominant explanation
- Key uncertainties

## Guardrails
- Avoid self‑referential commentary inside the report.
- Avoid dramatic or exaggerated language.
- Use simple, professional tone.
- Write entirely in the same language as the user.
