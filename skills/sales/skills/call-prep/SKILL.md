---
name: call-prep
description: Prepare for a sales call with account context, attendee research, and a suggested agenda. Works standalone with user input and targeted web research, and becomes Google Workspace-first when Calendar, Gmail, Drive, Sheets, and tagged workspace files are available.
---

# Call Prep

Get fully prepared for a sales call without rebuilding the whole account story from scratch. This skill should work as the seller workflow entrypoint: gather internal context first, add external context second, and produce a concise prep brief that can later hand off into deeper research or a presentation workflow if needed.

## How It Works

```text
┌─────────────────────────────────────────────────────────────────┐
│                        CALL PREP                                │
├─────────────────────────────────────────────────────────────────┤
│  ALWAYS (works standalone)                                      │
│  ✓ You tell me: company, meeting type, attendees               │
│  ✓ I build: agenda, questions, objections, prep checklist      │
│  ✓ I add: web research if internal context is limited          │
├─────────────────────────────────────────────────────────────────┤
│  GWS-FIRST (preferred path)                                     │
│  + Calendar: meeting shell, attendees, timing, notes           │
│  + Gmail: recent threads, commitments, unanswered questions    │
│  + Drive: decks, notes, proposals, transcript artifacts        │
│  + Sheets: account plans and trackers when relevant            │
│  + Tagged files: workspace-specific context via rag_query      │
│  + CRM: optional history and deal context                      │
└─────────────────────────────────────────────────────────────────┘
```

## Getting Started

When you run this skill, gather only what is still missing.

**Required if tools do not already provide it:**
- Company or contact name
- Meeting type

**Helpful if available:**
- Attendee names and titles
- Your goal for the call
- Any pasted notes, emails, or transcript snippets

If Calendar, Gmail, Drive, Sheets, or tagged files are available, use them before asking the user to restate obvious context.

## Retrieval Order

Follow this order every time:

1. Google Calendar for the meeting shell
2. Gmail for recent threads and unanswered questions
3. Google Drive for notes, decks, proposals, and transcript artifacts
4. Tagged workspace files via `rag_query`
5. Google Sheets for account plans or trackers when relevant
6. Google Search for current company, market, or attendee context
7. CRM only if connected or clearly requested

If a source is missing, keep going. Do not block the workflow because CRM or a transcript system is absent.

## Output Format

```markdown
# Call Prep: [Company Name]

**Meeting:** [Type] — [Date/Time if known]
**Attendees:** [Names with titles]
**Your Goal:** [What you want to accomplish]

---

## Account Snapshot

| Field | Value |
|-------|-------|
| **Company** | [Name] |
| **Industry** | [Industry] |
| **Size** | [Employees / Revenue if known] |
| **Status** | [Prospect / Active opportunity / Customer] |
| **Last Touch** | [Date and summary] |

---

## Who You're Meeting

### [Name] — [Title]
- **Background:** [Relevant background]
- **Role in Deal:** [Decision maker / Champion / Evaluator / etc.]
- **Last Interaction:** [Summary if known]
- **Talking Point:** [Something useful to reference]

---

## Context & History

**What's happened so far:**
- [Key point from prior interactions]
- [Open commitments or action items]
- [Concerns or objections raised]

**Recent updates about [Company]:**
- [News item 1 — why it matters]
- [News item 2 — why it matters]

---

## Suggested Agenda

1. **Open** — [Reference last conversation or trigger event]
2. **Discovery / Review** — [Topic]
3. **Objection Handling** — [Known concern]
4. **Next Steps** — [Specific alignment ask]

---

## Discovery Questions

1. [Question about current situation]
2. [Question about pain points or priorities]
3. [Question about decision process]
4. [Question about success criteria]

---

## Potential Objections

| Objection | Suggested Response |
|-----------|-------------------|
| [Likely objection] | [How to address it] |
| [Common objection for this stage] | [How to address it] |

---

## Pre-Call Checklist

- Read: [notes, deck, proposal, transcript]
- Confirm: [goal, next step, stakeholder]
- Bring: [proof point, example, pricing context]
```

## Execution Flow

### Step 1: Resolve the meeting

Use Calendar first whenever possible:

- find the most likely upcoming meeting
- capture title, time, attendee emails, description, and links
- infer the company or account from attendee domains and event title

If no meeting is available, ask only for the minimum:

- company or contact name
- meeting type
- timing if known

### Step 2: Pull internal account context

Use Gmail next:

- search recent messages and threads tied to attendee domains or company name
- identify open loops, prior commitments, objections, and attachments referenced
- note important unanswered messages or unresolved asks

Use Drive next:

- search for notes, decks, proposals, recap docs, and transcript files
- extract the latest relevant context instead of listing every file

Use `rag_query` for any tagged files:

- prefer tagged files before broad search
- treat them as high-trust context for this ask

Use Sheets if relevant:

- account plans
- pipeline trackers
- next-step checklists

### Step 3: Fill external gaps

Only after internal context is reviewed:

- search for recent news, funding, hiring, leadership changes, or product launches
- look up attendee backgrounds when that helps the meeting plan
- keep external enrichment short and decision-relevant

### Step 4: Synthesize

Combine all sources into a single prep brief:

- what we know
- what changed recently
- what matters in this meeting
- what to ask
- what could go wrong

## Meeting Type Variations

### Discovery Call
- Focus on understanding pain, priority, and process
- Agenda emphasis: questions over talking
- Key output: qualification signals and a next step

### Demo / Presentation
- Focus on relevant use cases and proof points
- Agenda emphasis: tailored walkthrough and feedback
- Key output: technical requirements and decision timeline

### Negotiation / Proposal Review
- Focus on concerns, value justification, and path to agreement
- Agenda emphasis: objection handling and next-step alignment
- Key output: blockers and close plan

### Check-in / QBR
- Focus on value delivered and new opportunities
- Agenda emphasis: outcomes, gaps, and expansion signals
- Key output: follow-up plan and stakeholder map

## Handoff Rules

This skill should stay brief-first by default.

Hand off only when the user clearly wants a bigger artifact:

- use `research` for a deeper account, industry, or market deep dive
- use `frontend-slides` when the user wants a call deck, QBR deck, or presentation

The handoff package should include:

- account and meeting summary
- key contacts and roles
- known priorities, objections, and goals
- the specific deliverable requested
- unresolved questions that still need input

### Example handoff: deeper account research

If the user says, "Prep me for tomorrow's Acme meeting and also give me a deeper view of their industry pressure," first produce the prep brief, then hand off the missing industry-depth portion to `research`.

### Example handoff: meeting deck

If the user says, "Prep me for the QBR and make a deck for it," first gather the Calendar, Gmail, Drive, and account context here, then pass the summary and audience goal into `frontend-slides`.

## Tips for Better Prep

1. More context still helps. Pasted notes, emails, or transcript snippets improve the brief.
2. Naming attendees improves the talking points and stakeholder analysis.
3. Stating the meeting goal makes the agenda better.
4. Flagging known concerns helps tailor the objection section.

## Notes

- Transcript lookup should prefer Gmail recap emails, then Drive docs/files.
- Do not assume direct Google Meet transcript APIs.
- Do not jump straight to Google Search before checking internal context.
