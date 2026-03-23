# Create an Asset

`create-an-asset` is a bundled HelpUDoc skill for turning sales context into a polished customer-facing deliverable.

Use it when you already know the account, audience, and goal, and you want the assistant to build something presentable rather than just summarize notes.

## Best use cases

- discovery follow-up pages
- executive one-pagers
- technical workflow demos
- custom landing pages for a target account
- deck-style customer presentations

## Supported output formats

| Format | Best for |
| ------ | -------- |
| Interactive landing page | Executive alignment, value storytelling, multi-section customer pages |
| Deck-style asset | Formal presentations or meeting-led walkthroughs |
| One-pager | Leave-behinds and concise executive summaries |
| Workflow / architecture demo | Technical flows, integrations, and proof-of-concept visuals |

## What the skill gathers first

The skill is designed to collect four kinds of context before it builds anything:

1. Prospect context: company, contacts, deal stage, pain points, prior materials
2. Audience context: who will read it and what they care about
3. Purpose context: the goal of the asset and desired next step
4. Format choice: landing page, deck, one-pager, or workflow demo

If context is sparse, the skill expands its research pass before generating the asset.

## Example prompts

```text
/create-an-asset
```

```text
Create an asset for Acme Corp focused on their VP Engineering and platform team.
They care about release velocity and developer productivity.
```

```text
Mock up a workflow demo for invoice processing:
email intake -> extraction -> ERP validation -> exception review.
```

## Output expectations

Typical outputs are:

- branded HTML assets
- narrative structure matched to the audience
- researched company and industry framing when needed
- room for follow-up iteration after the first draft

## Related skills

Use nearby skills when the job is narrower:

- `frontend-slides` for presentation-first workflows
- `proposal-writing` for proposals, SOWs, or commercial docs
- `call-prep`, `call-summary`, or `account-research` to gather better input context before asset creation

## Files in this folder

- `SKILL.md`: full skill instructions
- `QUICKREF.md`: invocation and prompt cheat sheet
