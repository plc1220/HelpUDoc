---
name: competitive-intelligence
description: Research competitors and build a seller-friendly brief or battlecard. Prefer internal docs and tagged workspace files first, then use current web research to refresh claims and market context.
---

# Competitive Intelligence

Help sellers position with evidence, not folklore. This skill should default to a concise competitive brief, while preserving the richer battlecard concepts from the original pack when the user explicitly wants them.

## How It Works

```text
┌─────────────────────────────────────────────────────────────────┐
│                  COMPETITIVE INTELLIGENCE                       │
├─────────────────────────────────────────────────────────────────┤
│  ALWAYS                                                         │
│  ✓ Competitor product and positioning research                 │
│  ✓ Recent releases, pricing, and win/loss framing             │
│  ✓ Talk tracks, objections, and landmine questions            │
├─────────────────────────────────────────────────────────────────┤
│  INTERNAL-FIRST                                                 │
│  + Drive battlecards, enablement docs, proposal material      │
│  + Tagged files and account context                           │
│  + Gmail notes only when competitor mentions matter           │
│  + CRM, chat, or transcripts as optional enrichment           │
└─────────────────────────────────────────────────────────────────┘
```

## Retrieval Order

1. Tagged workspace files via `rag_query`
2. Google Drive for battlecards, comparison docs, enablement notes, and proposal material
3. Gmail or recap notes only when they contain direct competitor mentions
4. Google Search for current pricing, releases, reviews, and positioning
5. CRM or win/loss data if available
6. Chat systems only if connected and relevant

## Default Output

Produce a brief-first artifact with:

- competitor summary
- where they win
- where we win
- likely objections they trigger
- suggested talk tracks
- landmine questions or discovery prompts

## Expanded Output When Requested

If the user explicitly wants a battlecard, preserve the richer structure from the original workflow:

- comparison matrix
- competitor-by-competitor sections
- pricing intelligence
- where they win versus where we win
- talk tracks by scenario
- objection handling and landmine questions

## Example Brief Structure

```markdown
# Competitive Brief: [Competitor]

## Quick Take
- Why they matter in deals:
- Where they are strongest:
- Where we should challenge them:

## Where They Win
- 

## Where We Win
- 

## Objections They Trigger
- 

## Talk Tracks
- Early mention:
- Active bake-off:
- Replacement / displacement:

## Landmine Questions
1.
2.
3.
```

## Execution Rules

- Reuse internal materials first so the output matches the team's current positioning.
- Use Google Search to validate and refresh current competitor claims.
- Treat CRM, transcript, and chat context as optional enrichment, not a requirement.
- Keep claims time-aware when discussing releases, pricing, or market moves.

## Handoff Rules

When the ask turns into a customer-facing or exec-facing artifact:

- hand off to `frontend-slides` for a competitor deck or presentation
- hand off to `create-an-asset` for a customer-facing comparison asset
- hand off to `research` if the user wants a deeper market landscape analysis

### Example handoff

If the seller asks for "a battlecard deck for our exec review," first build the competitive brief here, then pass the comparison structure and storyline into `frontend-slides`.
