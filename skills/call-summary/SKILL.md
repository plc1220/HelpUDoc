---
name: call-summary
description: Process call notes or a transcript to extract action items, draft a follow-up email, and generate an internal summary. Prefer Gmail, Drive, Calendar, and tagged files first, then hand off to proposal or presentation workflows only when the user actually needs them.
argument-hint: "<call notes or transcript>"
---

# /call-summary

Turn a meeting into clean next steps. This skill should summarize what happened, surface what changed, and prepare the follow-up path without overproducing documents by default.

## How It Works

```text
┌─────────────────────────────────────────────────────────────────┐
│                      CALL SUMMARY                               │
├─────────────────────────────────────────────────────────────────┤
│  STANDALONE (always works)                                      │
│  ✓ Paste call notes or transcript                              │
│  ✓ Extract decisions, action items, concerns, and next steps   │
│  ✓ Draft a customer-facing follow-up                           │
│  ✓ Generate internal recap for the team                        │
├─────────────────────────────────────────────────────────────────┤
│  GWS-FIRST (preferred path)                                     │
│  + Calendar: match the meeting and attendees                   │
│  + Gmail: find recap threads, transcript emails, draft follow-up│
│  + Drive: find transcript docs/files, notes, decks             │
│  + Tagged files: use workspace-specific context                │
│  + CRM: optional update path                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Usage

```text
/call-summary <notes or transcript>
```

Process these call notes: $ARGUMENTS

If a file is referenced: @$1

## What I Need From You

**Option 1: Paste notes**
Use rough notes, bullets, or stream-of-consciousness text.

**Option 2: Paste a transcript**
Use a Gemini recap email, transcript doc, or call transcript text.

**Option 3: Describe the call**
Example: "Had a discovery call with Acme. Met with their CTO and VP Eng. They're evaluating us against Competitor X. Main concern is integration timeline."

If likely transcript artifacts already exist in Gmail or Drive, use those before asking for more input.

## Retrieval Order

1. User-provided notes or transcript, if present
2. Google Calendar to identify the meeting shell
3. Gmail for recap emails, follow-up threads, and transcript emails
4. Google Drive for transcript docs, notes, decks, and proposal files
5. Tagged workspace files via `rag_query`
6. CRM only if connected or explicitly requested

## Output

### Internal Summary

```markdown
## Call Summary: [Company] — [Date]

**Attendees:** [Names and titles]
**Call Type:** [Discovery / Demo / Negotiation / Check-in]
**Source Reviewed:** [Notes / Gmail recap / Drive transcript / mixed]

### Key Discussion Points
1. [Topic] — [What was discussed, decisions made]
2. [Topic] — [Summary]

### Customer Priorities
- [Priority 1]
- [Priority 2]

### Risks / Objections Raised
- [Concern] — [Status or response]

### Competitive Intel
- [Any competitor mention]

### Action Items
| Owner | Action | Due |
|---|---|---|
| [You] | [Task] | [Date] |
| [Customer] | [Task] | [Date] |

### Recommended Next Step
- [Agreed next step with timeline]
```

### Customer Follow-Up Email

```text
Subject: [Meeting recap + next steps]

Hi [Name],

Thank you for taking the time to meet today...

[Key points discussed]

[Commitments you made]

[Clear next step with timeline]

Best,
[You]
```

## Email Style Guidelines

When drafting customer-facing emails:

1. Be concise but informative.
2. Do not use markdown formatting.
3. Use short paragraphs and simple lists.
4. Keep the email easy to skim.

**Good**

```text
Here's what we discussed:
- Quote for 20 seats at $480/seat/year
- W9 and supplier onboarding docs
- Point of contact for the contract
```

**Bad**

```text
**What You Need from Us:**
- Quote for 20 seats at $480/seat/year
```

## Execution Flow

### Step 1: Resolve the meeting context

If the user pasted notes, use them. Then enrich with:

- Calendar metadata for timing and attendees
- Gmail recap or transcript emails
- Drive notes or transcript files
- tagged files already in the workspace

Transcript policy:

1. search Gmail first
2. search Drive second
3. use Calendar details to confirm the right meeting
4. do not assume Meet-native transcript APIs

### Step 2: Extract the business signal

Always capture:

- decisions made
- customer priorities
- risks or objections raised
- competitor mentions
- action items with owners and timing
- what should happen next in the deal or account

### Step 3: Draft the outputs

- create the internal recap
- draft the customer follow-up
- create a Gmail draft when available; otherwise provide the plain-text draft inline

## Handoff Rules

Stay recap-first by default.

If the meeting clearly creates a larger downstream task:

- hand off to `proposal-writing` for proposals, SOWs, scopes, or commercials
- hand off to `frontend-slides` for recap decks, exec summaries, or customer-facing presentation material

The handoff brief should include:

- the deal or account context
- meeting outcomes and decisions
- priorities, objections, and requested deliverable
- any missing commercial or technical details

### Example handoff: proposal follow-up

If the meeting ends with "please send a proposal," first produce the recap and clear next-step summary here, then pass the commercial and scope context into `proposal-writing`.

### Example handoff: executive recap deck

If the user asks for a call summary plus an executive readout deck, first create the recap and action table here, then hand off the story, audience, and key outcomes to `frontend-slides`.

## Tips

1. Rough notes are enough if they contain the signal.
2. Attendee names make summaries and action items more accurate.
3. If something mattered a lot, call it out explicitly.
4. Deal stage helps tune the follow-up tone and next-step recommendation.

## Notes

- Do not ask for pasted notes if Gmail or Drive already contains likely transcript artifacts.
- Do not claim CRM updates happened unless the CRM path actually exists and was used.
