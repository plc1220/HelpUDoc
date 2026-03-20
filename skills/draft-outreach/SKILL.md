---
name: draft-outreach
description: Research a prospect then draft personalized outreach. Prefer Gmail, Drive, Sheets, and tagged files before web search, and create a Gmail draft when possible.
---

# Draft Outreach

Research first, then draft. This skill should never send generic outreach. Start with the seller's internal context, then enrich externally only where it improves the message.

## Connectors (Optional)

| Connector | What It Adds |
|-----------|--------------|
| **Gmail** | Create a draft directly in the inbox and inspect prior threads |
| **Drive** | Reuse notes, decks, battlecards, or account plans |
| **Sheets** | Pull territory or account-tracker context |
| **CRM** | Prior relationship context, existing contacts |
| **Enrichment** | Verified email, phone, background details |

> No connectors? The workflow still works. Return the email text and LinkedIn fallback.

## How It Works

```text
+------------------------------------------------------------------+
|                      DRAFT OUTREACH                              |
|                                                                  |
|  Step 1: RESEARCH (always happens first)                         |
|  - Gmail, Drive, Sheets, tagged files                            |
|  - Google Search only after internal review                      |
|  - CRM or enrichment if available                                |
|                                                                  |
|  Step 2: DRAFT                                                   |
|  - Personalized opening from real context                        |
|  - Relevant hook tied to priorities                              |
|  - Clear proof and CTA                                           |
|                                                                  |
|  Step 3: DELIVER                                                 |
|  - Gmail draft if available                                      |
|  - Plain-text output always                                      |
|  - LinkedIn fallback if no email                                 |
+------------------------------------------------------------------+
```

## Retrieval Order

1. Gmail for prior threads and open loops
2. Google Drive for notes, decks, proposals, and account plans
3. Tagged workspace files via `rag_query`
4. Google Sheets for territory or account-tracker context
5. Google Search for current company, role, or market updates
6. CRM or enrichment only if available

## Output Format

```markdown
# Outreach Draft: [Person] @ [Company]
**Generated:** [Date] | **Research Sources:** [Gmail, Drive, Sheets, Web, CRM]

## Research Summary
**Target:** [Name], [Title] at [Company]
**Hook:** [Why reaching out now]
**Goal:** [Desired outcome]

## Outreach Brief
- Relationship status:
- Why now:
- Proof points to reference:
- Ask / CTA:

## Email Draft
**To:** [email if known]
**Subject:** [Personalized subject line]

[Email body]

## Subject Line Alternatives
1. [Option 2]
2. [Option 3]

## LinkedIn Message (if no email)
**Connection Request (<300 chars):**
[Short connection request]

**Follow-up Message:**
[Value-first message]

## Why This Approach
| Element | Based On |
|---|---|
| Opening | [Research finding that makes it personal] |
| Hook | [Their priority or pain point] |
| Proof | [Relevant customer story] |
| CTA | [Low-friction ask] |
```

## Execution Flow

### Step 1: Check internal relationship context

Use Gmail first:

- search for prior conversations with the contact or domain
- detect whether this is cold, warm, or reactivation outreach
- note open loops or prior commitments

Use Drive and tagged files next:

- look for notes, battlecards, call summaries, decks, and proposal drafts
- reuse the customer's language when it exists

Use Sheets if relevant:

- territory notes
- account status
- next-step tracker rows

### Step 2: Enrich externally only when useful

Use Google Search after internal review:

- recent company news
- leadership or org change
- initiative or launch tied to the outreach angle

Keep external research short and specific. Do not pad the message with generic facts.

### Step 3: Identify the hook

Priority order:

1. Trigger event such as funding, hiring, or launch
2. Prior thread or warm relationship context
3. Their content or public statement
4. Company initiative
5. Role-based pain point

### Step 4: Draft the message

**Email structure**

```text
SUBJECT: [Personalized, short, non-spammy]

[Opening: personal hook]

[Interest: likely problem or opportunity]

[Desire: brief proof point]

[Action: clear CTA]
```

**LinkedIn connection request**

```text
Hi [Name], [genuine context]. Would love to connect.
```

## Message Templates By Scenario

### Cold Outreach

```text
Subject: [Their initiative] + [your angle]

Hi [Name],

[Personal hook based on research].

[1 sentence on likely challenge].

[Brief proof point].

Worth a 15-min call to see if relevant?
```

### Warm Outreach

```text
Subject: Following up from [context]

Hi [Name],

[Reference to how you know them].

[Why reaching out now].

[Specific value you can offer].

[CTA]
```

### Re-Engagement

```text
Subject: [Short, curiosity-driven]

Hi [Name],

[Acknowledge time passed].

[New reason to reconnect].

[Simple question to reopen dialogue].
```

### Post-Event Follow-Up

```text
Subject: Great meeting you at [Event]

Hi [Name],

[Specific memory from conversation].

[Value-add or resource].

[Soft CTA for next conversation].
```

## Email Style Guidelines

1. Be concise but informative.
2. No markdown formatting.
3. Use short paragraphs.
4. Keep the CTA low-friction.

## Handoff Rules

Stay outreach-first by default.

Escalate only when the ask clearly becomes a larger asset:

- hand off to `proposal-writing` if the outreach is really a proposal or commercial follow-up
- hand off to `frontend-slides` if the user needs a pitch deck, visual narrative, or presentation asset

When handing off, include:

- target account and contact
- deal stage or outreach objective
- proof points and pain points
- desired call to action

### Example handoff: proposal-led outreach

If the seller says, "Write the follow-up and include a proposal next step," draft the outreach here first, then hand off the commercial document creation to `proposal-writing`.

### Example handoff: pitch narrative

If the seller says, "Draft outreach and make me a deck for the meeting," draft the message here, then pass the story, audience, and hook into `frontend-slides`.

## Notes

- Gmail drafts are preferred, but plain-text output is an acceptable fallback.
- Do not default to Google Search before checking internal context.
