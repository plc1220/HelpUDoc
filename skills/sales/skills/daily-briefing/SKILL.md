---
name: daily-briefing
description: Start your day with a prioritized sales briefing. Works standalone when you tell me your meetings and priorities, and becomes Google Workspace-first when Calendar, Gmail, Drive, Sheets, and tagged workspace files are connected.
---

# Daily Sales Briefing

Get a clear view of what matters most today. This skill should work with whatever the seller gives you, but succeed best when Calendar and Gmail are available. Keep it operational, concise, and useful in under two minutes of reading.

## How It Works

```text
┌─────────────────────────────────────────────────────────────────┐
│                      DAILY BRIEFING                             │
├─────────────────────────────────────────────────────────────────┤
│  ALWAYS (works standalone)                                      │
│  ✓ You tell me today's meetings, deals, and priorities         │
│  ✓ I organize a prioritized action plan                        │
│  ✓ Output is a scannable daily briefing                        │
├─────────────────────────────────────────────────────────────────┤
│  GWS-FIRST (preferred path)                                     │
│  + Calendar: today's meetings and attendees                    │
│  + Gmail: urgent replies, no-reply threads, recap emails       │
│  + Drive: prep docs, decks, notes, proposals                   │
│  + Sheets: trackers and account plans                          │
│  + Tagged files: workspace context via rag_query               │
│  + CRM: optional pipeline alerts and task context              │
└─────────────────────────────────────────────────────────────────┘
```

## Getting Started

When you run this skill, only ask for what is still missing.

**If no calendar context exists:**
"What meetings do you have today?"

**If no Sheets or CRM context exists:**
"What deals or accounts need attention this week?"

**If tools are connected:**
Pull the context automatically and produce the briefing.

## Retrieval Order

1. Google Calendar for today's meetings
2. Gmail for urgent inbound and no-reply follow-ups
3. Google Drive for prep docs, decks, and recap materials
4. Tagged workspace files via `rag_query`
5. Google Sheets for trackers or account plans
6. CRM if connected
7. Google Search only when a priority account needs same-day external context

## Output Format

```markdown
# Daily Briefing | [Day, Month Date]

## #1 Priority
**[Most important thing to do today]**
[Why it matters and what to do]

## Today's Numbers
| Open Pipeline | Closing This Month | Meetings Today | Action Items |
|---|---|---|---|
| $[X] | $[X] | [N] | [N] |

## Today's Meetings
### [Time] — [Company] ([Meeting Type])
**Attendees:** [Names]
**Context:** [Deal status or last touch]
**Prep:** [Quick action]

## Email Priorities
### Needs Response
| From | Subject | Received |
|---|---|---|

### Waiting On Reply
| To | Subject | Sent | Days Waiting |
|---|---|---|---|

## Prep Materials
- [Doc / deck / note]

## Suggested Actions
1. **[Action]** — [Why now]
2. **[Action]** — [Why now]
3. **[Action]** — [Why now]
```

Only include pipeline or forecast sections when Sheets or CRM data actually exists.

## Execution Flow

### Step 1: Gather the day's internal context

Use Calendar:

- list external-facing meetings
- capture attendees, times, and short descriptions

Use Gmail:

- find unread buyer or stakeholder emails
- identify sent-without-reply threads that matter today
- find recap or transcript emails tied to today's accounts

Use Drive:

- find decks, notes, proposals, or recap docs connected to today's meetings

Use Sheets or CRM only if they add real prioritization value:

- pipeline trackers
- account plans
- close dates
- overdue tasks

### Step 2: Prioritize

Default ranking:

1. urgent meeting prep for a live account conversation
2. urgent buyer reply or blocker
3. close-date or next-step risk from Sheets or CRM
4. stale follow-up that needs action today

### Step 3: Generate the briefing

Assemble only the sections supported by real data:

1. #1 Priority
2. Today's Meetings
3. Email Priorities
4. Prep Materials
5. Suggested Actions
6. Today's Numbers or Pipeline Alerts if Sheets or CRM adds them

## Quick Mode

If the user asks for "quick brief" or "tl;dr my day", return:

```markdown
# Quick Brief | [Date]

**#1:** [Priority action]

**Meetings:** [N] — [Company 1], [Company 2]

**Alerts:**
- [Alert 1]
- [Alert 2]

**Do Now:** [Most important action]
```

## End Of Day Mode

If the user asks for "wrap up my day" or "end of day summary":

```markdown
# End of Day | [Date]

**Completed:**
- [Meeting 1] — [Outcome]
- [Meeting 2] — [Outcome]

**Tomorrow's Focus:**
- [Priority 1]
- [Priority 2]

**Open Loops:**
- [ ] [Follow-up item]
```

## Handoff Rules

Stay operational by default.

If one account clearly needs deeper same-day context:

- hand off to `research` for a focused account, market, or industry brief

### Example handoff

If the daily briefing reveals a high-stakes meeting with a fast-changing account, produce the daily brief first, then route the missing deep background to `research` rather than turning the daily brief into a long report.

## Tips

1. Calendar and Gmail are the biggest time savers.
2. Drive and Sheets add useful prep and tracker context.
3. CRM helps, but the workflow should still work well without it.
4. Google Search is enrichment, not the starting point.
