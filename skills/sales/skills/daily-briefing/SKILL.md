---
name: daily-briefing
description: Start your day with a prioritized sales briefing. Works standalone when you tell me your meetings and priorities, and becomes Google Workspace-first when Calendar, Gmail, Drive, and Sheets are connected. Trigger with "morning briefing", "daily brief", "what's on my plate today", "prep my day", or "start my day".
---

# Daily Sales Briefing

Get a clear view of what matters most today. This skill works with whatever you tell me, and gets richer when you connect your tools.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                      DAILY BRIEFING                              │
├─────────────────────────────────────────────────────────────────┤
│  ALWAYS (works standalone)                                       │
│  ✓ You tell me: today's meetings, key deals, priorities         │
│  ✓ I organize: prioritized action plan for your day             │
│  ✓ Output: scannable 2-minute briefing                          │
├─────────────────────────────────────────────────────────────────┤
│  SUPERCHARGED (when you connect your tools)                      │
│  + Calendar: auto-pull today's meetings with attendees          │
│  + Gmail: unread buyer messages, waiting on replies             │
│  + Drive: today's prep docs, notes, proposal files              │
│  + Sheets: pipeline trackers or account spreadsheets            │
│  + CRM: pipeline alerts, tasks, deal health                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Getting Started

When you run this skill, I'll ask for what I need:

**If no calendar connected:**
> "What meetings do you have today? (Just paste your calendar or list them)"

**If no CRM or Sheets connected:**
> "What deals are you focused on this week? Any that need attention?"

**If you have connectors:**
I'll pull everything automatically and just show you the briefing.

---

## Connectors (Optional)

Connect your tools to supercharge this skill:

| Connector | What It Adds |
|-----------|--------------|
| **Calendar** | Today's meetings with attendees, times, and context |
| **Gmail** | Unread from opportunity contacts, emails waiting on replies, transcript recap emails |
| **Drive** | Today's prep docs, decks, notes, proposals |
| **Sheets** | Pipeline trackers, account plans, next-step sheets |
| **CRM** | Open pipeline, deals closing soon, overdue tasks, stale deals |

> **No connectors?** No problem. Tell me your meetings and deals, and I'll create your briefing.

---

## Output Format

```markdown
# Daily Briefing | [Day, Month Date]

---

## #1 Priority

**[Most important thing to do today]**
[Why it matters and what to do about it]

---

## Today's Numbers

| Open Pipeline | Closing This Month | Meetings Today | Action Items |
|---------------|-------------------|----------------|--------------|
| $[X] | $[X] | [N] | [N] |

---

## Today's Meetings

### [Time] — [Company] ([Meeting Type])
**Attendees:** [Names]
**Context:** [One-line: deal status, last touch, what's at stake]
**Prep:** [Quick action before this meeting]

### [Time] — [Company] ([Meeting Type])
**Attendees:** [Names]
**Context:** [One-line context]
**Prep:** [Quick action]

*Run `call-prep [company]` for detailed meeting prep*

---

## Pipeline Alerts

### Needs Attention
| Deal | Stage | Amount | Alert | Action |
|------|-------|--------|-------|--------|
| [Deal] | [Stage] | $[X] | [Why flagged] | [What to do] |

### Closing This Week
| Deal | Close Date | Amount | Confidence | Blocker |
|------|------------|--------|------------|---------|
| [Deal] | [Date] | $[X] | [H/M/L] | [If any] |

---

## Email Priorities

### Needs Response
| From | Subject | Received |
|------|---------|----------|
| [Name @ Company] | [Subject] | [Time] |

### Waiting On Reply
| To | Subject | Sent | Days Waiting |
|----|---------|------|--------------|
| [Name @ Company] | [Subject] | [Date] | [N] |

---

## Suggested Actions

1. **[Action]** — [Why now]
2. **[Action]** — [Why now]
3. **[Action]** — [Why now]

---

*Run `call-prep [company]` before your meetings*
*Run `call-summary` after each call*
```

---

## Execution Flow

### Step 1: Gather Context

**If connectors available:**
```
1. Calendar → Get today's events
   - Filter to external meetings (non-company attendees)
   - Pull: time, title, attendees, description

2. Gmail → Check priority messages
   - Unread from opportunity contact domains
   - Sent messages with no reply (3+ days)

3. Drive → Search today's prep materials
   - Pull: notes, decks, proposals, transcript docs/files tied to today's accounts

4. Sheets → Check trackers (if available)
   - Pull: account plans, pipeline spreadsheets, next-step trackers

5. CRM → Query your pipeline
   - Open opportunities owned by you
   - Flag: closing this week, no activity 7+ days, slipped dates
   - Get: overdue tasks, upcoming tasks
```

**If no connectors:**
```
Ask user:
1. "What meetings do you have today?"
2. "What deals are you focused on? Any closing soon or needing attention?"
3. "Anything urgent I should know about?"

Work with whatever they provide.
```

### Step 2: Prioritize

```
Priority ranking:
1. URGENT: Deal closing today/tomorrow not yet won
2. HIGH: Meeting today with high-value opportunity
3. HIGH: Unread email from decision-maker
4. MEDIUM: Deal closing this week
5. MEDIUM: Stale deal (7+ days no activity)
6. LOW: Tasks due this week

Select #1 Priority:
- If meeting with >$50K deal today → prep that
- If deal closing today → focus on close
- If urgent email from buyer → respond first
- Else → highest-value stale deal
```

### Step 3: Generate Briefing

```
Assemble sections based on available data:

1. #1 Priority — Always include (even if simple)
2. Today's Numbers — If CRM or Sheets connected, otherwise skip
3. Today's Meetings — From calendar or user input
4. Pipeline Alerts — If CRM connected
5. Email Priorities — If Gmail connected
6. Suggested Actions — Always include top 3 actions
```

---

## Quick Mode

Say "quick brief" or "tldr my day" for abbreviated version:

```markdown
# Quick Brief | [Date]

**#1:** [Priority action]

**Meetings:** [N] — [Company 1], [Company 2], [Company 3]

**Alerts:**
- [Alert 1]
- [Alert 2]

**Do Now:** [Single most important action]
```

---

## End of Day Mode

Say "wrap up my day" or "end of day summary" after your last meeting:

```markdown
# End of Day | [Date]

**Completed:**
- [Meeting 1] — [Outcome]
- [Meeting 2] — [Outcome]

**Pipeline Changes:**
- [Deal] moved to [Stage]

**Tomorrow's Focus:**
- [Priority 1]
- [Priority 2]

**Open Loops:**
- [ ] [Unfinished item needing follow-up]
```

---

## Tips

1. **Connect Calendar and Gmail first** — Biggest time saver
2. **Add Drive or Sheets next** — Unlocks prep docs and pipeline trackers
3. **Add CRM if you have one** — Best for stage hygiene and forecast context

---

## Related Skills

- **call-prep** — Deep prep for any specific meeting
- **call-summary** — Process notes after calls
- **account-research** — Research a company before first meeting
