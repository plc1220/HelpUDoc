---
name: research
description: >
  Produce a sourced research report in the user's language using a structured,
  evidence-first workflow. Supports quick, standard, deep, and exhaustive
  research modes. Prioritizes evidence quality, entity disambiguation,
  claim verification, contradiction checking, uncertainty handling, and clear
  synthesis before final writing.
tools:
  - google_search
  - request_plan_approval
  - request_clarification
  - request_human_action
requires_hitl_plan: true
requires_workspace_artifacts: true
required_artifacts_mode: full_pack
required_artifacts:
  - /question.txt
  - /research_mode.md
  - /entity_disambiguation.md
  - /preliminary_search_notes.md
  - /research_plan.md
  - /source_register.md
  - /research_notes.md
  - /claim_evidence_matrix.md
  - /contradictions_and_uncertainties.md
  - /red_flags_and_exclusions.md
  - /knowledge_graph.md
  - /synthesis.md
  - /final_report_audit.md
  - /final_quality_check.md
  - /final-research-report.md
pre_plan_search_limit: 3
source_skills:
  - research-core
  - research-sub_researcher
  - research-critique
---

# research

## Overview

Use this skill to research a topic and deliver a structured, well-sourced report in the same language as the user.

This skill emphasizes:

- Evidence grounding before writing
- Entity disambiguation before comparison
- Source-quality ranking
- Claim-level verification
- Contradiction and uncertainty tracking
- Cross-source synthesis
- Clear separation between verified facts, interpretation, and speculation
- Professional, non-hype writing

The goal is not merely to produce a long report. The goal is to produce a report whose major claims have earned the right to appear.

## Core Principles

1. Do not write before evidence is gathered.
2. Do not merge ambiguous entities without disambiguation.
3. Do not include unsupported numbers, dates, benchmarks, legal claims, pricing, funding details, CVEs, architecture claims, or adoption claims.
4. Prefer primary sources over secondary sources.
5. Actively search for contradictory evidence.
6. State uncertainty clearly when evidence is incomplete.
7. Match research depth to the question.
8. Make final synthesis analytical, not stitched notes.

## Research Depth Modes

Before full research begins, classify the request into one of these modes and record it in `/research_mode.md`.

### Quick Research

Use when the user asks for a narrow factual answer or a short explanation.

- Final report length: 800-1,500 words in `/final-research-report.md`
- Minimum credible sources: 4
- Minimum primary sources: 1 where available
- Use only essential artifacts when the topic is narrow

### Standard Research

Use for normal explanatory or comparative research.

- Final report length: 2,500-4,500 words in `/final-research-report.md`
- Minimum credible sources: 10
- Minimum primary sources: 3 where available

### Deep Research

Use when the query involves:

- Comparing 3 or more entities
- Technical architecture
- Market or strategic positioning
- Emerging AI tools, models, frameworks, companies, or platforms
- Complex policy, scientific, business, or economic analysis
- Prompts containing "vs", "compare", "evaluate", "landscape", "benchmark", "strategy", "architecture", "best", or "trade-off"

Requirements:

- Final report length: 6,000-10,000 words in `/final-research-report.md`
- Minimum credible sources: 18
- Minimum primary sources: 8 where available
- One standalone dossier per major entity
- Comparison matrix
- Claim-evidence matrix
- Contradiction and uncertainty log
- Limits of evidence section
- Strategic implications section

### Exhaustive Research

Use when the user explicitly asks for an exhaustive landscape, investment memo, policy review, academic-style report, or due-diligence report.

- Final report length: 10,000-18,000 words in `/final-research-report.md`
- Minimum credible sources: 30
- Minimum primary sources: 12 where available
- Multiple synthesis passes required
- Include alternative interpretations and falsification criteria

If the user does not specify a depth, choose the appropriate mode automatically and explain the choice briefly in the research plan.

## Output Rules

- Write all report content to Markdown files in the workspace.
- Do not paste the full report in chat unless explicitly requested.
- In chat, provide only:
  - The proposed research mode
  - The research plan
  - Short progress updates
  - Final confirmation with file path(s)
- Each major section must be written as a separate Markdown file before consolidation.
- Generate a Mermaid knowledge graph before final stitching.
- The final report must include:
  - Clear Markdown headings
  - Inline numeric citations
  - A Sources section
  - A Limits of Evidence section when evidence is incomplete
  - A computed word count at the bottom, not shown in chat

## Word Count Definition

Unless explicitly stated otherwise, "final report word count" refers only to the words in `/final-research-report.md`.

Do not count:

- `/claim_evidence_matrix.md`
- `/research_notes.md`
- `/comparison_matrix.md`
- `/knowledge_graph.md`
- Entity dossier drafts
- `/synthesis.md`
- `/source_register.md`
- `/final_quality_check.md`
- Any other supporting artifact

Supporting artifacts may be longer than the final report, but they do not count toward the final report word-count requirement.

Never report an estimated final report word count. Always compute the count from the actual final report file.

The final report's Word Count section must use this exact form:

```markdown
## Word Count

1234 words
```

Use the actual integer count. Do not add qualifiers, parentheses, methodology notes, estimates, or explanations in the final report.

Forbidden final-report word-count phrases:

- "approx"
- "approximately"
- "estimated"
- "manual count"
- "roughly"
- "about"

If any of these phrases appear in the final report's Word Count section, the report fails the completion gate.

Known failing examples:

```markdown
## Word Count
(Manual count of /final-research-report.md content)
Approx 6,400 words.
```

```markdown
## Word Count
Approximately 7,200 words.
```

Both examples fail because they are not computed integer counts and contain forbidden qualifiers.

## Workflow

### 1. Record the Question

Write the original user question to `/question.txt`.

Do not reinterpret the question silently.

### 2. Classify Research Mode

Create `/research_mode.md`.

Include:

- Selected mode: Quick / Standard / Deep / Exhaustive
- Reason for selection
- Expected final report word count
- Expected source count
- Expected primary-source count
- Whether entity dossiers are required
- Whether comparison matrices are required

Example:

```markdown
# Research Mode

Selected mode: Deep Research

Reason:
The user is comparing multiple entities and asks for technical and strategic evaluation.

Expected final report length:
6,000-10,000 words

Minimum sources:
18 credible sources

Minimum primary sources:
8 where available
```

### 3. Entity Disambiguation

Create `/entity_disambiguation.md`.

For every named entity, product, company, model, framework, law, or technical term in the user question:

- List possible meanings
- Identify the most likely meaning
- Identify alternative meanings that may affect the answer
- State whether clarification is required
- If clarification is not required, define the interpretation used in the report

Rules:

- Do not silently merge similarly named entities.
- Do not assume that similarly named projects are related.
- If an entity cannot be verified, mark it as uncertain.
- If ambiguity materially affects the report, call `request_clarification`.

Example:

```markdown
# Entity Disambiguation

## Entity: Pi Agent

Possible meanings:
1. Inflection AI's Pi assistant
2. A coding-agent project using the name Pi
3. A component inside another framework

Decision:
The report will distinguish these meanings unless primary sources prove they are the same.

Clarification needed:
No, because the ambiguity itself is relevant to the research.
```

### 4. Preliminary Search

Run 2-3 lightweight searches before plan approval.

Purpose:

- Confirm the topic is real and current
- Identify major entities
- Identify obvious ambiguity
- Improve the plan

Record findings in `/preliminary_search_notes.md`.

Include:

- Search queries used
- Sources found
- Early findings
- Early uncertainties
- Possible source-quality issues
- Current timeline anchor

Do not perform full evidence gathering yet.

### 5. Draft Research Plan

Create `/research_plan.md`.

The plan must include:

- Scope definition
- Out-of-scope items
- Research mode
- Key research questions
- Topic classification:
  - Descriptive
  - Comparative
  - Technical
  - Historical
  - Policy
  - Market
  - Strategic
  - Predictive
- Source strategy
- Expected source types
- Proposed section outline
- Required artifacts
- Known uncertainties
- Risks of hallucination or ambiguity

Then call `request_plan_approval` with:

- `plan_title`
- `plan_summary`
- `execution_checklist`
- `risky_actions` when relevant
- `reviewer_feedback` when editing a previously proposed plan

A limited pre-plan search of 2-3 calls is allowed before approval, but the main evidence gathering must wait for approval.

If the user edits the plan, update `/research_plan.md` and request approval again.

If the user rejects the plan, stop.

### 6. Source Gathering

Use `google_search` to collect sources.

Prioritize primary sources first.

#### Source Priority

Tier A - Primary Sources:

- Official documentation
- GitHub repositories
- Release notes
- Model cards
- Company blogs
- API docs
- Regulatory text
- Court filings
- SEC filings
- Government databases
- NVD / CVE records
- Academic papers
- Standards bodies

Tier B - Reputable Secondary Sources:

- Reuters
- Associated Press
- Bloomberg
- Financial Times
- The Verge
- Wired
- TechCrunch
- IEEE Spectrum
- Major security vendors
- Recognized industry analysts

Tier C - Low-Confidence Sources:

- SEO blogs
- Content farms
- Unsourced newsletters
- Medium posts
- AI-generated-looking articles
- Aggregator pages
- Vendor comparison pages without primary citations

Rules:

- Architecture claims require Tier A evidence.
- Pricing claims require Tier A evidence.
- Benchmark claims require Tier A evidence.
- Security claims require Tier A evidence, preferably NVD, CVE, official advisories, or vendor disclosures.
- Legal status claims require Tier A evidence.
- Funding or acquisition claims require Tier A or strong Tier B evidence.
- Adoption claims such as star counts, user counts, revenue, downloads, or market share require direct evidence.

### 7. Source Register

Create `/source_register.md`.

For every source, include:

```markdown
## Source [1]

Title:
URL:
Final URL after redirects:
Publisher / author:
Date:
Access date:
Fetch status: reachable / unreachable / paywalled / redirected / failed
Source tier: A / B / C
Primary or secondary:
Key claims:
Claims supported:
Claims not supported:
Useful for:
Limitations:
Reliability notes:
```

The final report may cite only sources that appear in the source register.

### 8. Source Link Validation

Before finalizing, open every URL listed in the final report's Sources section.

For each cited source, record in `/source_register.md`:

- URL
- Final URL after redirects
- Fetch status: reachable / unreachable / paywalled / redirected / failed
- Source tier
- Claims supported
- Claims not supported

Rules:

- If a cited URL is unreachable, do not cite it in the final report unless the report clearly marks it as unavailable and explains why it is still relevant.
- If a URL redirects, cite the final working URL unless the original URL is itself the evidence target.
- If the page is paywalled, use it only for claims visible in accessible metadata, snippets, abstracts, or other legally accessible text.
- Do not use a source for a claim when the opened page does not directly support that claim.
- Re-run source link validation after changing the Sources section.

### 9. Research Notes

Create `/research_notes.md`.

Include:

- Key claims per source
- Important statistics
- Important dates
- Important definitions
- Technical details
- Relevant quotes or paraphrases
- Conflicting claims
- Open questions
- Evidence gaps

No report prose should begin before this file exists.

### 10. Claim-Evidence Matrix

Create `/claim_evidence_matrix.md`.

Every major factual claim must be recorded before appearing in the final report.

Use this structure:

```markdown
| Claim | Source(s) | Source tier | Evidence summary | Confidence | Include? |
|---|---|---|---|---|---|
| Claim text | [1], [2] | A / B | Short evidence note | High / Medium / Low / Exclude | Yes / No |
```

Confidence rules:

- High: directly supported by a primary source and no credible contradiction found.
- Medium: supported by reputable secondary sources or indirectly by multiple independent sources, with no strong contradiction found.
- Low: supported only by weak sources, unclear wording, dated evidence, or inference.
- Exclude: unsupported, contradicted, speculative, unreliable, or too specific for available evidence.

Rules:

- Only High and Medium claims may appear in the main report.
- Low-confidence claims may appear only in a clearly labeled uncertainty section.
- Excluded claims must not appear in the final report.
- Do not cite a source if it does not directly support the claim.

### 11. Contradiction Search

Create `/contradictions_and_uncertainties.md`.

For each major claim, perform contradiction-oriented searches where appropriate.

Useful search patterns:

```text
[claim keywords] official
[claim keywords] GitHub
[claim keywords] documentation
[claim keywords] benchmark
[claim keywords] pricing
[claim keywords] CVE
[claim keywords] controversy
[claim keywords] fake
[claim keywords] not true
[claim keywords] acquisition
[claim keywords] release notes
```

Record:

- Claims checked
- Search queries used
- Contradictory evidence found
- Missing primary evidence
- Whether the claim should be downgraded, excluded, or reframed

### 12. Red Flags and Exclusions

Create `/red_flags_and_exclusions.md`.

Use this file to track claims that were tempting but should not be included.

Include:

```markdown
| Excluded claim | Reason excluded | Source issue | Safer wording |
|---|---|---|---|
```

Claims that require caution include:

- Exact user counts
- GitHub stars
- Revenue numbers
- Legal status
- Acquisition rumors
- Benchmark scores
- Model parameter counts
- Security vulnerability impact
- "Industry standard"
- "Best"
- "Dominant"
- "First"
- "Revolutionary"
- "Uncensored"
- "Zero risk"
- "Guaranteed"

### 13. Entity Dossiers

For Standard, Deep, and Exhaustive comparative reports, create one standalone dossier per major entity.

Use filenames such as:

```text
/01_entity_openclaw.md
/02_entity_hermes.md
/03_entity_pi.md
```

Each dossier should include:

- What it is
- What it is not
- Developer / organization
- Timeline
- Open-source or proprietary status
- Architecture
- Model layer vs agent layer
- Memory or state mechanism
- Tool-use mechanism
- Deployment model
- Integrations
- Pricing or cost model, only if verified
- Benchmarks, only if verified
- Security posture
- Known limitations
- Ecosystem maturity
- Evidence quality
- Open questions

For Deep Research mode, each dossier should be 800-1,500 words.

For Exhaustive Research mode, dossiers may be longer.

### 14. Section Writing

Write each major section as a separate Markdown file using zero-padded filenames:

```text
/01_tldr.md
/02_scope.md
/03_methodology.md
/04_background.md
/05_findings.md
/06_comparative_analysis.md
/07_implications.md
/08_recommendations.md
/09_conclusion.md
```

Rules:

- Each major section must include citations.
- Each section must be based on the research notes and claim-evidence matrix.
- Do not introduce new claims during section writing unless they are added to the claim-evidence matrix.
- If a section file exists, edit it rather than overwrite it.
- For Deep Research mode, major sections should generally be 700-1,200 words.
- For Standard Research mode, major sections should generally be 300-700 words.

### 15. Knowledge Graph

Create `/knowledge_graph.md`.

Use Mermaid.

The graph must include:

- At least 5 entities
- At least 5 labeled relationships
- Meaningful edges
- Structural, causal, competitive, or dependency relationships

Example:

```mermaid
graph TD
    A[Company A] -->|develops| B[Product B]
    B -->|competes with| C[Product C]
    B -->|depends on| D[Model Layer]
    C -->|targets| E[Enterprise Users]
```

The knowledge graph should reflect the actual evidence, not generic grouping.

### 16. Comparative Matrix

For comparative research, create `/comparison_matrix.md` before final synthesis.

Use dimensions relevant to the topic.

For technical or product comparisons, include:

- Category
- Developer / organization
- What it is
- Open-source / proprietary status
- Architecture
- Deployment model
- Memory / state model
- Tool-use model
- Integrations
- Context limits, if verified
- Pricing, if verified
- Benchmarks, if verified
- Security posture
- Strengths
- Weaknesses
- Best-fit use cases
- Evidence confidence

### 17. Cross-Source Synthesis

Create `/synthesis.md`.

This file must exist before the final report.

Include:

- Patterns across sources
- Agreements
- Disagreements
- Evidence gaps
- What is well supported
- What is weakly supported
- What remains unknown
- Alternative interpretations
- What evidence would change the conclusion
- Practical implications

The synthesis must go beyond summarizing sources. Explain what the evidence means.

### 18. Final Report Consolidation

Create `/final-research-report.md`, unless the user specifies another filename.

The final report must be based on the section files, synthesis file, comparison matrix when present, and claim-evidence matrix.

The final report must itself satisfy the selected mode's word-count range. Supporting artifacts are evidence and drafting material; they are not part of the final report word count.

Do not merely stitch sections mechanically.

The final consolidation must:

- Remove duplicate claims
- Preserve important details
- Add transitions
- Explain causal relationships
- Separate facts from interpretation
- Clearly mark uncertainty
- Include comparison tables where useful
- Include practical recommendations where appropriate
- Avoid unsupported superlatives
- Use simple, professional language
- Compute the actual word count from `/final-research-report.md` after writing; do not estimate it

### 19. Final Report Required Structure

Adapt as needed, but default to:

```markdown
# Title

## TL;DR

## Scope and Research Questions

## Methodology and Evidence Quality

## Entity Disambiguation

## Background

## Findings

## Comparative Analysis

## Risks and Limitations

## Strategic or Practical Implications

## Recommendations

## Limits of Evidence

## Conclusion

## Sources

## Word Count
```

For technical comparisons, include:

```markdown
## Model Layer vs Agent Layer

## Architecture and Runtime

## Memory and State

## Tool Use and Integrations

## Deployment and Operations

## Security Posture

## Use-Case Fit
```

For policy topics, include:

```markdown
## Regulatory Context

## Stakeholders

## Compliance Implications

## Enforcement Risks

## Alternative Interpretations
```

For market topics, include:

```markdown
## Market Structure

## Competitive Landscape

## Business Model

## Adoption Signals

## Risks to the Thesis
```

### 20. Citation Rules

Use numeric citations:

```markdown
This is a factual claim [1].
```

Rules:

- Every factual claim involving numbers, dates, benchmarks, pricing, legal status, funding, security, or architecture must include a citation.
- Every factual claim involving CVEs, vulnerabilities, privilege escalation, remote code execution, adoption, community preference, or "best fit" claims must include a direct citation or be framed as analysis.
- Do not cite the same source more than 3 times unless essential.
- Prefer primary sources.
- Use secondary sources mainly for commentary and context.
- Do not cite sources that were not read or recorded.
- Do not use fake citations.
- Do not cite a source if it does not directly support the claim.
- If evidence is weak, say so.
- Do not cite unreachable URLs unless clearly marked as unavailable.

End with:

```markdown
## Sources

[1] Source Title: URL
[2] Source Title: URL
```

### 21. Writing Style Rules

Use a clear, professional tone.

Avoid hype.

Do not use these unless directly supported by strong evidence:

- revolutionary
- dominant
- unprecedented
- world-class
- best
- definitive
- industry standard
- absolute
- massive
- game-changing
- state-of-the-art
- zero-risk
- fully autonomous
- uncensored
- guaranteed
- favorite
- preferred choice
- only viable choice
- highest intelligence ceiling
- dominated by

Prefer:

- "available evidence suggests"
- "reported by"
- "according to"
- "appears to"
- "is positioned as"
- "is designed to"
- "is claimed to"
- "could indicate"
- "the evidence is insufficient to confirm"
- "is suitable for"
- "illustrates a different architectural pattern"
- "appears better suited to"
- "based on the available sources"

### 22. Failure Handling

If evidence is limited, include a **Limits of Evidence** section.

If sources conflict, include a **Conflicting Evidence** subsection.

If primary sources cannot be found, say so clearly.

If the topic is speculative or emerging, state that clearly.

Never fabricate missing data to meet word count.

Never fill gaps with confident-sounding assumptions.

### 23. Under-Length Final Report Handling

If `/final-research-report.md` is below the selected mode minimum:

1. Do not claim completion.
2. Do not report an estimated word count.
3. Expand the final report section by section using only existing dossiers, synthesis, comparison matrix, source register, research notes, and claim-evidence matrix.
4. Preserve citations and evidence confidence.
5. Recompute the word count after expansion.
6. Repeat until the computed word count is within the selected mode range, or explicitly downgrade the mode through plan approval before finalizing.

For Deep Research mode, if `/final-research-report.md` is below 6,000 words, it fails the quality gate even if all supporting artifacts combined exceed 6,000 words.

For Exhaustive Research mode, if `/final-research-report.md` is below 10,000 words, it fails the quality gate even if all supporting artifacts combined exceed 10,000 words.

### 24. Mandatory Computed Word Count

Before finalizing, compute the actual word count of `/final-research-report.md` programmatically. Prefer a deterministic file-based count such as `wc -w final-research-report.md` from the workspace root.

Write this to `/final_quality_check.md`:

```markdown
## Mandatory Computed Word Count

- Final report file: `/final-research-report.md`
- Computed word count:
- Required word count range:
- Pass / fail:
```

The computed word count must be derived from the final report file only. Do not estimate it. Do not use manual estimates. Do not count workspace artifacts, notes, dossiers, matrices, source registers, quality checks, or chat messages.

If the computed word count is below the selected mode minimum, do not finalize. Expand the final report using the existing dossiers, synthesis, comparison matrix, source register, research notes, and claim-evidence matrix, then recompute the word count.

### 25. Final Report Audit

Before declaring completion, create `/final_report_audit.md`.

This audit must inspect `/final-research-report.md` itself, not the artifact pack.

Include:

```markdown
# Final Report Audit

Final report path:
Computed final report word count:
Required range:
Word count command or method:
Word Count section exact text:
Forbidden word-count phrase present: yes / no
Sources listed in final report:
Source URLs opened:
Unreachable sources:
Sources missing from source register:
High-risk uncited claims found:
Low-confidence claims outside uncertainty sections:
Excluded claims found in final report:
Completion decision: pass / fail
```

The audit fails if the final report contains:

- `(Manual count of /final-research-report.md content)`
- `Approx`
- `approximately`
- `estimated`
- Any non-integer or qualified word count
- A cited source URL that was not opened
- A source URL that returned 404, DNS failure, network failure, or unrelated content
- A final citation source missing from `/source_register.md`
- High-risk factual claims without direct citation

If `/final_report_audit.md` says `Completion decision: fail`, do not finalize and do not claim completion in chat.

### 26. Final Report Completion Gate

Before declaring completion, produce `/final_quality_check.md` with:

- Final report path
- Computed word count of `/final-research-report.md`
- Required word count range
- Source count
- Primary source count
- Number of claims in `/claim_evidence_matrix.md`
- Number of excluded claims
- Number of low-confidence claims still present in the final report
- Number of source URLs checked
- Number of source URLs unreachable, paywalled, redirected, or failed
- `/final_report_audit.md` completion decision

Completion is forbidden if:

- Computed word count is below the selected mode minimum.
- Any source URL in the final Sources section is unreachable and not clearly marked unavailable.
- Any factual claim with numbers, CVEs, benchmarks, architecture, pricing, legal status, security impact, funding, or adoption lacks citation.
- Final report cites sources not present in `/source_register.md`.
- The final report says "manual count", "approx", "approximately", "estimated", "roughly", or "about" in its Word Count section.
- The final report Word Count section is not exactly an integer followed by `words`.
- `/final_report_audit.md` is missing or says `Completion decision: fail`.
- Any Low-confidence claim appears in the main report outside a clearly labeled uncertainty or limits-of-evidence section.
- Any Excluded claim appears in the final report.

### 27. Quality Gate Before Final Report

Before finalizing, run a self-check and record it in `/final_quality_check.md`.

Check:

```markdown
# Final Quality Check

- [ ] Research mode matches query complexity
- [ ] Entity disambiguation completed
- [ ] Source register completed
- [ ] Claim-evidence matrix completed
- [ ] Contradiction search completed
- [ ] Red flags and exclusions recorded
- [ ] Every cited source URL was opened and recorded with fetch status in `/source_register.md`
- [ ] Unreachable URLs are removed or clearly marked unavailable
- [ ] Knowledge graph completed
- [ ] Synthesis completed
- [ ] Mandatory computed word count completed from `/final-research-report.md` only
- [ ] Computed final report word count is within the selected mode range
- [ ] Final report Word Count section does not use approximate/manual/estimated wording
- [ ] Final report Word Count section is exactly an integer followed by `words`
- [ ] `/final_report_audit.md` exists and says `Completion decision: pass`
- [ ] Final report completion gate passed
- [ ] Final report cites only registered sources
- [ ] Unsupported claims removed
- [ ] Low-confidence claims appear only in uncertainty or limits-of-evidence sections
- [ ] Excluded claims do not appear in the final report
- [ ] Uncertainty clearly marked
- [ ] No fake citations
- [ ] No unsupported numbers
- [ ] No unsupported superlatives
- [ ] Report length claim, if any, matches the computed word count
```

Do not finalize the report until this check is complete.
