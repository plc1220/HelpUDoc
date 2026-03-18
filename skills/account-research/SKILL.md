---
name: account-research
description: Research a company or person and get actionable sales intel. Start with internal context, then expand to current external research. Prefer tagged workspace files, Drive docs, Gmail history, and Sheets context before broader web research.
---

# Account Research

Get a complete picture of a company or person before outreach or a meeting, but keep the result useful for sellers rather than encyclopedic. This skill should produce a sharp brief that mixes internal knowledge with timely external context.

## How It Works

```text
┌─────────────────────────────────────────────────────────────────┐
│                     ACCOUNT RESEARCH                            │
├─────────────────────────────────────────────────────────────────┤
│  ALWAYS                                                         │
│  ✓ Company overview, current updates, key people               │
│  ✓ Signals that matter for outreach or discovery               │
│  ✓ Recommended angle and questions                             │
├─────────────────────────────────────────────────────────────────┤
│  INTERNAL-FIRST                                                 │
│  + Tagged files, Drive docs, Gmail history, Sheets notes       │
│  + Google Search for current public context                    │
│  + CRM and enrichment as optional sharpening layers            │
└─────────────────────────────────────────────────────────────────┘
```

## Retrieval Order

1. Tagged workspace files via `rag_query`
2. Google Drive for notes, decks, proposals, or prior account plans
3. Gmail for prior conversations or recap emails
4. Google Sheets for trackers or territory notes
5. Google Search for current public context
6. CRM and enrichment if available

## Output Format

```markdown
# Research: [Company or Person Name]

**Generated:** [Date]
**Sources:** [Tagged files / Drive / Gmail / Web / CRM / Enrichment]

## Quick Take
[2-3 sentences on why this account matters now]

## Company Profile
| Field | Value |
|---|---|
| Company | [Name] |
| Industry | [Industry] |
| Size | [Employee count] |
| Headquarters | [Location] |
| Funding | [If known] |

### Recent Updates
- [Update 1 — why it matters]
- [Update 2 — why it matters]

## Key People
### [Name] — [Title]
- Background:
- Talking point:
- Internal relationship context:

## Qualification Signals
### Positive Signals
- [Signal]

### Potential Concerns
- [Concern]

### Unknowns
- [What to ask next]

## Recommended Approach
- Best entry point:
- Opening hook:
- Discovery questions:
```

## Execution Rules

- Prefer internal context first when it exists.
- Use Google Search to fill gaps or get current developments, not as the only source by default.
- If the user tagged files, use those before broad searching.
- CRM and enrichment should sharpen the brief, not define the entire workflow.

## Handoff Rules

If the research ask becomes broader than a seller brief:

- hand off to `research` for a deeper market, industry, or multi-source report
- hand off to `draft-outreach` if the real ask is to turn the findings into outreach
- hand off to `call-prep` if the findings are meant to prep an upcoming meeting

### Example handoff

If the user asks, "Research this account and write me a long industry report," produce the seller brief here, then route the deeper report work to `research`.
