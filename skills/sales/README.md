# Sales Skills

A Google Workspace-first sales skill pack for HelpUDoc. Treat this pack as the entrypoint for seller workflows: it gathers internal context from Gmail, Calendar, Drive, Sheets, and tagged workspace files, then produces concise sales briefs, drafts, and next-step plans. When the ask turns into a bigger deliverable, the pack should hand off to the right specialized skill instead of recreating that workflow inside sales.

## Workflow Map

| Workflow | Default output | Best-fit sources | Downstream handoff |
|---|---|---|---|
| `call-prep` | Prep brief, objections, agenda, meeting goals | Calendar, Gmail, Drive, Sheets, tagged files | `research` for deeper market/account research, `frontend-slides` for decks or QBRs |
| `call-summary` | Internal recap, action items, Gmail-ready follow-up | Gmail, Drive, Calendar, tagged files | `proposal-writing` for SOW/proposal asks, `frontend-slides` for recap decks |
| `daily-briefing` | Prioritized daily agenda and prep checklist | Calendar, Gmail, Drive, Sheets | `research` for high-priority account deep dives |
| `draft-outreach` | Outreach brief plus Gmail draft | Gmail, Drive, Sheets, tagged files | `proposal-writing` for proposal-led outreach, `frontend-slides` for pitch narratives |

## How The Pack Should Work

Default source order for seller workflows:

1. Google Workspace internal context
2. Tagged workspace files and internal docs
3. Google Search for current external enrichment
4. CRM or enrichment systems when present

That means:

| Need | Default source |
|---|---|
| Upcoming meetings and attendees | Google Calendar |
| Threads, follow-ups, transcript emails | Gmail |
| Notes, decks, proposals, recap docs, transcripts | Google Drive |
| Account trackers and pipeline sheets | Google Sheets |
| Tagged project files already in the workspace | `rag_query` before broad search |
| Company news or industry developments | `google_search`, after internal context review |
| Deal history or stage hygiene | CRM, when available |

Transcript handling in v1 is intentionally simple:

1. Search Gmail for recap or transcript emails.
2. Search Drive for transcript docs, notes, or recording metadata.
3. Use Calendar metadata to confirm the right meeting.
4. Do not assume direct Google Meet transcript APIs.

## Downstream Skills

The sales pack should prepare context, then hand off when the user wants a larger artifact:

| User intent | Preferred downstream skill |
|---|---|
| Deep account, market, or industry analysis | `research` |
| Proposal, SOW, scope, or commercial document | `proposal-writing` |
| Pitch deck, QBR, exec recap, or presentation | `frontend-slides` |
| Customer-facing asset such as one-pager or landing page | `create-an-asset` |

Handoffs should be brief-first, not automatic heavy generation. Sales skills should capture:

- customer and meeting context
- current priorities or pain points
- objections, risks, and decision criteria
- open questions and missing data
- the intended downstream deliverable

## Commands

| Command | Description |
|---|---|
| `/call-summary` | Turn notes or transcript artifacts into action items, internal notes, and a Gmail-ready follow-up |
| `/forecast` | Build a weighted forecast from CSV, Sheets, or CRM exports |
| `/pipeline-review` | Review pipeline health from CSV, Sheets, or CRM exports |

## Skills

| Skill | Description |
|---|---|
| `account-research` | Account and contact research that starts with internal context, then expands to web search |
| `call-prep` | Build a prep brief from meeting metadata, email history, Drive notes, Sheets context, and optional external research |
| `call-summary` | Process call notes or transcript artifacts, then create recap and follow-up outputs |
| `competitive-intelligence` | Build battlecards using internal docs plus current market research |
| `create-an-asset` | Generate customer-facing assets when a deal needs a polished deliverable |
| `daily-briefing` | Prioritized seller briefing using today’s meetings, inbox signals, and optional pipeline data |
| `draft-outreach` | Context-rich outreach that becomes a Gmail draft when possible |
| `forecast` | Forecast from Sheets, CSV, or CRM data with CRM as enrichment, not a requirement |
| `pipeline-review` | Weekly health review using Sheets, CSV, or CRM data |

## Notes

- These skills are adapted for HelpUDoc and should cooperate with the general router and other specialized skills.
- Default outputs should be brief-first markdown artifacts unless the user explicitly wants a larger document or deck.
- CRM remains optional but still improves `forecast`, `pipeline-review`, and historical account context.
- If Google OAuth scopes expand, existing users need to sign in with Google again so Gmail, Calendar, Drive, and Sheets access can be delegated to MCP servers.
