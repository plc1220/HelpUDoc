---
name: proposal-writing
description: Create, revise, or polish a professional Statement of Work (SOW) / proposal for data, analytics, AI, or cloud modernization. Use when asked to draft a proposal, improve an existing proposal, produce a formal SOW, or convert rough proposal notes into a consistent workspace artifact and optional DOCX-ready format.
mcp_servers:
  - aws-pricing
  - aws-knowledge
  - google-developer-knowledge
  - gcp-cost
requires_workspace_artifacts: true
required_artifacts_mode: strict
required_artifacts:
  - /research_context.md
  - /proposal_config.json
  - /01_executive_summary.md
  - /02_business_requirements.md
  - /03_architecture.md
  - /04_scope_of_work.md
  - /05_assumptions_out_of_scope.md
  - /06_success_criteria.md
  - /07_commercials.md
  - /proposal_quality_review.md
  - /Final_Proposal.md
---

# proposal-writing

## Output rules (must follow)
- Write all proposal content to markdown files in the workspace; do not paste full sections in chat.
- Use write_file to create or replace canonical section files and /Final_Proposal.md.
- Use append_to_report only for a brand-new proposal where /Final_Proposal.md is empty or only contains the generated title block. For revisions, polishing, "finalize", "update wording", or "make this better" tasks, rebuild /Final_Proposal.md from canonical section files with write_file instead of appending.
- If append_to_report is unavailable, or if there is any risk of duplicate content, read the section file(s) and rebuild /Final_Proposal.md with write_file.
- Reply in chat only with short progress updates and final confirmation.
- Default proposal visuals to Mermaid inside markdown. Do not switch to image generation unless the user explicitly asks for a static visual artifact such as PNG/JPG/diagram image.
- If the user explicitly asks for a static image export from proposal content or names `gemini_image`, treat that as authorization to call `gemini_image` after reading the relevant section file and extracting the specific table/diagram to visualize.
- For those explicit image-export requests, do not hand off to unrelated sales asset workflows unless the user asks for a broader customer-facing asset.
- `Final_Proposal.md` must preserve the wording of each section file. Stitch from the section files exactly; do not paraphrase, compress, or rewrite section prose while assembling the final document.
- When the user provides an existing proposal or polished example, treat it as source material to be revised in place. Do not append "new improved sections" after the existing proposal unless the user explicitly asks for an addendum.
- When the user provides DOCX examples, use their structure and level of formality as a style template, but keep markdown as the canonical editable source unless a DOCX export tool is explicitly available.

## Proposal quality standard
Good proposals in this workspace should feel like a commercial SOW, not a generic generated report. Default to the following structure unless the user asks for a lighter proposal:

1. Title block with customer, proposal name, date, version/status, prepared by/for.
2. Preface or confidentiality note for formal SOWs.
3. Executive Summary with business context, pain, proposed transformation, timeline, and investment.
4. Background & Current State, including concrete operational constraints.
5. Business Requirements, split into functional and non-functional requirements.
6. Proposed Technical Architecture, with a concise component narrative and Mermaid diagram.
7. Implementation Deliverables.
8. Scope of Work & Timeline, including WBS, Gantt, and RACI when appropriate.
9. Assumptions and Out of Scope.
10. Success Criteria & KPIs, with measurable acceptance criteria and disclaimers.
11. Commercials, including one-time fees, optional support/retainer, run-cost estimates, and next steps.
12. Technical Capability / Experience when it strengthens the proposal.
13. Signature blocks for formal SOWs.

Style rules:
- Be specific to the client and business problem. Replace placeholders and generic claims with concrete workloads, latency, cost, volume, platform, and timeline assumptions.
- Prefer precise wording such as "validate", "benchmark", "migrate", "production hardening", and "acceptance criteria" over vague transformation language.
- Use tables for option comparisons, WBS, deliverables, risks, KPIs, commercials, and signatures.
- Include assumptions and caveats next to aggressive KPI/cost claims.
- Do not invent customer approvals, commitments, partner status, or delivered project counts unless supplied by the user or verified.
- Do not use old platform/model knowledge when current facts matter. For model capabilities, service availability, pricing, dates, quotas, product names, partner designations, and funding programs, prefer current MCP/provider docs or web-grounded results over memory and over stale workspace artifacts.
- If a claim cannot be verified, label it as an assumption, dependency, or item for confirmation. Never make unsupported claims sound like facts.

## Evidence and freshness rules
The proposal must be evidence-first. `/research_context.md` is not optional background; it is the factual spine of the proposal.

`/research_context.md` must include these sections:
- `Research timestamp`: the host date/time used for the run.
- `User-provided facts`: facts supplied by the user or attached artifacts.
- `Verified sources`: dated source notes with provider, URL/tool/source name, retrieval date, and a one-line relevance note.
- `Provider documentation used`: AWS, Google Cloud, Microsoft, or other official docs/tools consulted, including pricing tools where used.
- `Pricing assumptions`: units, region, monthly volume, model mix, storage/query assumptions, and what was not priced.
- `Unknowns not verified`: open facts that must be confirmed by the client or implementation team.

Each section task in `/proposal_config.json` must include:
- `evidence_refs`: named bullets or source labels from `/research_context.md` that the section is allowed to rely on.
- `assumptions_allowed`: claims that may be presented only as assumptions.
- `unsupported_claims_forbidden`: claims that must not appear unless verified, including partner status, delivered project counts, customer commitments, ARR, pricing, performance targets, model/version availability, and roadmap/funding program claims.

No unsupported claims rule:
- Partner status, customer commitment, delivered project counts, ARR, pricing, funding eligibility, model capabilities, product availability, dates, latency/accuracy/scaling targets, and implementation timelines must be user-provided, source-verified, or explicitly labeled as assumptions.
- If fresh sources conflict with a prior proposal or attachment, use the fresh source and note the conflict in `/proposal_quality_review.md`.

## Revision mode (critical)
Use revision mode when the user says any of: revise, polish, refine, finalize, improve, update wording, make it better, compare with this version, use this as example, or when /Final_Proposal.md already exists.

Revision mode workflow:
1. Read the existing proposal, section files, attached examples, and /proposal_config.json when present.
2. Build a short revision map in /proposal_revision_plan.md:
   - source section
   - issue found
   - replacement strategy
   - target file
3. Rewrite the affected section files with write_file. Preserve useful wording, but improve weak prose directly in its original section.
4. Rebuild /Final_Proposal.md from the section files in order using write_file. Do not call append_to_report in revision mode.
5. Verify there are no duplicate top-level sections, no "addendum" blocks unless requested, and no original weak section followed by a stronger replacement.

Append-avoidance tests before final response:
- Search /Final_Proposal.md for repeated headings such as "Executive Summary", "Commercials", "Scope Boundary", "Production Roadmap", or duplicate section numbers.
- If duplicates exist because of an earlier append, repair by rebuilding /Final_Proposal.md from canonical section files.
- If a new idea belongs in an existing section, merge it there; do not place it at the end.

## Workflow
### Phase 1 - Research
1. Use google_search for at most 2 queries to gather:
   - Client strategic goals and transformation initiatives.
   - Current stack constraints / technical debt.
   - Relevant reference architecture for the use case (cloud-agnostic unless the user specifies a provider).
2. If the user explicitly wants an AWS proposal, AWS service guidance, or AWS cost detail:
   - prefer `aws-knowledge` for AWS service capabilities, implementation references, and feature availability
   - prefer `aws-pricing` for cost and SKU lookups before falling back to assumptions
3. If the user explicitly wants a Google Cloud / GCP proposal, Google implementation guidance, or GCP cost detail:
   - prefer `google-developer-knowledge` for official Google Cloud, Firebase, Android, Maps, and broader Google developer documentation
   - prefer `gcp-cost` for Google Cloud service, SKU, and pricing estimates before falling back to assumptions
4. If search fails or times out, proceed with reasonable assumptions and label them as assumptions.
5. Write findings to /research_context.md with write_file. Highlight specific business pains the solution addresses, and include the mandatory evidence/freshness sections listed above.
6. Respond: Research complete. Saved to /research_context.md.

### Phase 2 - Plan
1. Read /research_context.md.
2. Create a todo list:
   - Preferred: use write_todos if available.
   - Fallback: write /todos.md with write_file using this checklist:
     - [x] Research complete
     - [ ] Plan sections
     - [ ] Write section 1: Executive Summary
     - [ ] Write section 2: Business Requirements
     - [ ] Write section 3: Architecture (with Mermaid diagram)
     - [ ] Write section 4: Scope of Work (WBS + Gantt + RACI)
     - [ ] Write section 5: Assumptions and Out of Scope
     - [ ] Write section 6: Success Criteria
     - [ ] Write section 7: Commercials
     - [ ] Stitch all sections into Final_Proposal.md
3. Create /proposal_config.json with write_file, defining the 7 sections and a task_instruction for each that references research findings. Every section definition must include `evidence_refs`, `assumptions_allowed`, and `unsupported_claims_forbidden`.
4. Initialize /Final_Proposal.md with write_file to include a title, date, and a short outline placeholder. If /Final_Proposal.md already exists, do not append to it; enter revision mode.

### Phase 3 - Write & Stitch (one section at a time)
For each section in order:
1. Read /proposal_config.json and focus on a single section.
2. Resume logic: If the section file already exists, prefer it as the source of truth. Do not trust /Final_Proposal.md as proof that the section is correct unless the wording materially matches the section file.
3. Write the section file using write_file. Do not compress sections to save output tokens; if the turn budget feels tight, complete fewer sections well and resume later. Minimum section depth:
   - Executive Summary: 600-900 words, with concrete business pain, proposed approach, timeline, value, and investment/commercial framing where known.
   - Business Requirements: at least 8 functional requirements and 6 non-functional requirements, each grounded in evidence or marked as an assumption.
   - Architecture: at least 700 words plus a Mermaid diagram and a component table.
   - Scope of Work: WBS table, Gantt, RACI, and at least 400 words of delivery narrative.
   - Assumptions and Out of Scope: at least 8 assumptions and 8 exclusions.
   - Success Criteria: KPI table, acceptance criteria, and KPI disclaimers.
   - Commercials: milestone table, OPEX/run-cost assumptions where relevant, change-request handling, and next steps.
   - /01_executive_summary.md
   - /02_business_requirements.md
   - /03_architecture.md
   - /04_scope_of_work.md
   - /05_assumptions_out_of_scope.md
   - /06_success_criteria.md
   - /07_commercials.md
4. For a new proposal only, append the section into /Final_Proposal.md using append_to_report. For revisions or existing final files, skip appending and rebuild /Final_Proposal.md from all completed section files with write_file.
5. After stitching or rebuilding, verify the final content still matches the section file. If the wording was compressed, altered, duplicated, or partially omitted, repair /Final_Proposal.md from the section file content before moving on.
6. Update todos after each section (mark in-progress then complete). If using /todos.md, rewrite it with write_file.

### Phase 3.5 - Optional Static Visual Exports
Only run this phase if the user asked for static image outputs.
1. Finish the markdown section files first, including Mermaid diagrams in /03_architecture.md and /04_scope_of_work.md.
2. Then generate any requested static visuals from the completed markdown artifacts:
   - architecture diagram image from /03_architecture.md
   - Gantt chart image from /04_scope_of_work.md
   - RACI matrix image from /04_scope_of_work.md
3. Save these as separate workspace artifacts, for example:
   - /architecture-diagram.png
   - /gantt-chart.png
   - /raci-matrix.png
4. Treat the completed markdown files as the canonical source. The images are derivative exports, not replacements for the markdown artifacts.

### Phase 4 - Complete
1. Verify /Final_Proposal.md exists.
2. Before final rebuild, create `/proposal_quality_review.md` with write_file. It must include:
   - `Freshness check`: stale dates, old product/model names, and current-fact claims checked.
   - `Evidence check`: unsupported or weakly supported claims found.
   - `Depth check`: thin sections, missing required tables, or generic filler.
   - `Duplicate/append check`: repeated headings or appended replacement sections.
   - `Required fixes`: critical issues that must be resolved before final response, or `None`.
3. If `/proposal_quality_review.md` lists any unresolved critical issue, rewrite the affected section files and update the quality review before responding.
4. Re-read every section file and rebuild /Final_Proposal.md from those exact contents in order if there is any mismatch, compression, paraphrase, duplicate heading, appended addendum, or missing block.
5. Confirm that the final file contains the same section wording as:
   - /01_executive_summary.md
   - /02_business_requirements.md
   - /03_architecture.md
   - /04_scope_of_work.md
   - /05_assumptions_out_of_scope.md
   - /06_success_criteria.md
   - /07_commercials.md
6. Confirm that all required artifacts exist:
   - /research_context.md
   - /proposal_config.json
   - all seven section files
   - /proposal_quality_review.md
   - /Final_Proposal.md
7. Respond with: Proposal complete. Check /Final_Proposal.md (includes Mermaid diagrams)

## Section requirements (exhaustive)
### 1) Executive Summary
- Frame the problem, desired outcomes, and high-level approach.
- Emphasize business value and timeline.

### 2) Business Requirements
- State clear functional and non-functional requirements.
- Tie each requirement to research findings or pains.

### 3) Architecture
- Include a Mermaid flowchart using graph LR.
- Reference platform-appropriate products (cloud-agnostic unless the user specifies a provider).
- Describe data ingestion, transformation, storage, governance, and analytics layers.

### 4) Scope of Work
**A. Work Breakdown Structure (WBS) Table**
- Use columns: WBS ID, Task Name, Description, Deliverable, Owner, Duration.

**B. Gantt Chart**
- Provide a Mermaid Gantt chart showing phase timelines and dependencies.

**C. RACI Matrix**
- Include roles such as Client Sponsor, Business Owner, Data Engineer, Cloud Architect, Security, PM.
- Mark Responsible / Accountable / Consulted / Informed per major task.

### 5) Assumptions & Out of Scope
- List explicit assumptions and exclusions.
- Call out dependencies (e.g., data access, stakeholder availability).

### 6) Success Criteria
- Define measurable outcomes and acceptance criteria.
- Include KPIs (latency, cost, performance, accuracy, adoption).

### 7) Commercials
- Provide pricing/engagement assumptions, timeline estimate, and next steps.
- When the proposal is GCP-specific and `gcp-cost` results are available, anchor commercials to those MCP-derived estimates and clearly label any remaining assumptions.
- Include change-request handling and optional services.

## DOCX-ready output guidance
- Markdown remains canonical: /Final_Proposal.md and section files are the source of truth.
- Use a DOCX-friendly structure: Heading 1 for numbered main sections, Heading 2/3 for subsections, tables for repeated commercial or governance details, and plain bullets for short lists.
- Avoid Mermaid-only critical information if the user asks for DOCX. Include a table or textual architecture summary alongside Mermaid because DOCX export may not render Mermaid.
- If a DOCX creation/export tool is available, create /Final_Proposal.docx from /Final_Proposal.md after verifying the markdown. If no DOCX export tool is available, produce a DOCX-ready markdown file and clearly state that the workspace currently has the markdown source ready for export.

## Critical rules
- Do not write all sections at once.
- Write and stitch exactly one section at a time.
- Sections 3 and 4 must include Mermaid diagrams.
- If the user asks for static chart or diagram images, generate them only after the markdown sections are complete.
- Keep /proposal_config.json as the single source of truth.
- If you resume mid-run, reuse existing files and skip completed sections.
- Never let /Final_Proposal.md become a summarized version of the section files. The section files are canonical; the final proposal is an exact rebuild from them.
- Never satisfy a revision request by appending new improved content after the old content.
