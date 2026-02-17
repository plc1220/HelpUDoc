---
name: proposal-writing
description: Create a multi-section Statement of Work (SOW) proposal for data/analytics or cloud modernization. Use when asked to research, plan, and draft a resumable proposal with Mermaid diagrams and to save all output as markdown files in the workspace, including a stitched /Final_Proposal.md.
---

# proposal-writing

## Output rules (must follow)
- Write all proposal content to markdown files in the workspace; do not paste full sections in chat.
- Use write_file for every new file and append_to_report to stitch sections into /Final_Proposal.md.
- If append_to_report is unavailable, read the section file and append it by rewriting /Final_Proposal.md with write_file.
- Reply in chat only with short progress updates and final confirmation.

## Workflow
### Phase 1 - Research
1. Use google_search for at most 2 queries to gather:
   - Client strategic goals and transformation initiatives.
   - Current stack constraints / technical debt.
   - Relevant reference architecture for the use case (cloud-agnostic unless the user specifies a provider).
2. If search fails or times out, proceed with reasonable assumptions and label them as assumptions.
3. Write findings to /research_context.md with write_file. Highlight specific business pains the solution addresses.
4. Respond: Research complete. Saved to /research_context.md.

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
3. Create /proposal_config.json with write_file, defining the 7 sections and a task_instruction for each that references research findings.
4. Initialize /Final_Proposal.md with write_file to include a title, date, and a short outline placeholder.

### Phase 3 - Write & Stitch (one section at a time)
For each section in order:
1. Read /proposal_config.json and focus on a single section.
2. Resume logic: If the section file already exists or its content is already in /Final_Proposal.md, mark it complete and continue.
3. Write the section file (400-800 words) using write_file:
   - /01_executive_summary.md
   - /02_business_requirements.md
   - /03_architecture.md
   - /04_scope_of_work.md
   - /05_assumptions_out_of_scope.md
   - /06_success_criteria.md
   - /07_commercials.md
4. Append the section into /Final_Proposal.md using append_to_report.
5. Update todos after each section (mark in-progress then complete). If using /todos.md, rewrite it with write_file.

### Phase 4 - Complete
1. Verify /Final_Proposal.md exists.
2. Respond with: Proposal complete. Check /Final_Proposal.md (includes Mermaid diagrams)

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
- Include change-request handling and optional services.

## Critical rules
- Do not write all sections at once.
- Write and stitch exactly one section at a time.
- Sections 3 and 4 must include Mermaid diagrams.
- Keep /proposal_config.json as the single source of truth.
- If you resume mid-run, reuse existing files and skip completed sections.
