---
name: call-summary
description: Process call notes or a transcript — extract action items, draft follow-up email, and generate an internal summary. Prefer Gmail, Drive, and Calendar context when available, especially for transcript lookup and follow-up drafts.
argument-hint: "<call notes or transcript>"
---

# /call-summary

> If you see unfamiliar placeholders or need to check which tools are connected, see [CONNECTORS.md](../../CONNECTORS.md).

Process call notes or a transcript to extract action items, draft follow-up communications, and update records.

## Usage

```
/call-summary <notes or transcript>
```

Process these call notes: $ARGUMENTS

If a file is referenced: @$1

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                      CALL SUMMARY                                │
├─────────────────────────────────────────────────────────────────┤
│  STANDALONE (always works)                                       │
│  ✓ Paste call notes or transcript                               │
│  ✓ Extract key discussion points and decisions                  │
│  ✓ Identify action items with owners and due dates              │
│  ✓ Surface objections, concerns, and open questions             │
│  ✓ Draft customer-facing follow-up email                        │
│  ✓ Generate internal summary for your team                      │
├─────────────────────────────────────────────────────────────────┤
│  SUPERCHARGED (when you connect your tools)                      │
│  + Gmail: find recap threads, transcript emails, draft follow-up│
│  + Drive: find transcript docs/files, notes, decks              │
│  + Calendar: link to meeting, attendee context, meeting timing  │
│  + CRM: update opportunity, log activity, create tasks          │
└─────────────────────────────────────────────────────────────────┘
```

---

## What I Need From You

**Option 1: Paste your notes**
Just paste whatever you have — bullet points, rough notes, stream of consciousness. I'll structure it.

**Option 2: Paste a transcript**
If you have a full transcript from your meeting tool, Gemini recap email, or a transcript doc from Drive, paste it. I'll extract the key moments.

**Option 3: Describe the call**
Tell me what happened: "Had a discovery call with Acme Corp. Met with their VP Eng and CTO. They're evaluating us vs Competitor X. Main concern is integration timeline."

---

## Output

### Internal Summary
```markdown
## Call Summary: [Company] — [Date]

**Attendees:** [Names and titles]
**Call Type:** [Discovery / Demo / Negotiation / Check-in]
**Duration:** [If known]

### Key Discussion Points
1. [Topic] — [What was discussed, decisions made]
2. [Topic] — [Summary]

### Customer Priorities
- [Priority 1 they expressed]
- [Priority 2]

### Objections / Concerns Raised
- [Concern] — [How you addressed it / status]

### Competitive Intel
- [Any competitor mentions, what was said]

### Action Items
| Owner | Action | Due |
|-------|--------|-----|
| [You] | [Task] | [Date] |
| [Customer] | [Task] | [Date] |

### Next Steps
- [Agreed next step with timeline]

### Deal Impact
- [How this call affects the opportunity — stage change, risk, acceleration]
```

### Customer Follow-Up Email
```
Subject: [Meeting recap + next steps]

Hi [Name],

Thank you for taking the time to meet today...

[Key points discussed]

[Commitments you made]

[Clear next step with timeline]

Best,
[You]
```

---

## Email Style Guidelines

When drafting customer-facing emails:

1. **Be concise but informative** — Get to the point quickly. Customers are busy.
2. **No markdown formatting** — Don't use asterisks, bold, or other markdown syntax. Write in plain text that looks natural in any email client.
3. **Use simple structure** — Short paragraphs, line breaks between sections. No headers or bullet formatting unless the customer's email client will render it.
4. **Keep it scannable** — If listing items, use plain dashes or numbers, not fancy formatting.

**Good:**
```
Here's what we discussed:
- Quote for 20 seats at $480/seat/year
- W9 and supplier onboarding docs
- Point of contact for the contract
```

**Bad:**
```
**What You Need from Us:**
- Quote for 20 seats at $480/seat/year
```

---

## If Connectors Available

**Gmail or Drive connected:**
- I'll search for transcript emails, recap threads, and transcript docs/files tied to the meeting
- Pull relevant notes or transcript excerpts
- Extract key moments, decisions, and follow-up commitments

**CRM connected:**
- I'll offer to update the opportunity stage
- Log the call as an activity
- Create tasks for action items
- Update next steps field

**Email connected:**
- I'll offer to create a draft in ~~email
- Or send directly if you approve

**Calendar connected:**
- I'll use the meeting title, time, and attendees to match the right thread or transcript artifact

---

## Tips

1. **More detail = better output** — Even rough notes help. "They seemed concerned about X" is useful context.
2. **Name the attendees** — Helps me structure the summary and assign action items.
3. **Flag what matters** — If something was important, tell me: "The big thing was..."
4. **Tell me the deal stage** — Helps me tailor the follow-up tone and next steps.
