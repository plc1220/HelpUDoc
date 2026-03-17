# Sales Skills

A Google Workspace-first sales skill pack for HelpUDoc. The workflows work standalone with web research and pasted context, and get better when Gmail, Google Calendar, Google Drive, Google Sheets, and optional CRM tools are connected through MCP.

## Priority Workflows

| Workflow | Best-Fit Data Sources |
|---|---|
| `call-prep` | Calendar, Gmail, Drive, optional CRM |
| `call-summary` | Gmail, Drive, Calendar, optional CRM |
| `daily-briefing` | Calendar, Gmail, Sheets, optional CRM |
| `draft-outreach` | Gmail drafts, Drive context, web research, optional CRM |

## Commands

| Command | Description |
|---|---|
| `/call-summary` | Turn notes or transcript artifacts into action items, internal notes, and a Gmail-ready follow-up |
| `/forecast` | Build a weighted forecast from CSV, Sheets, or CRM exports |
| `/pipeline-review` | Review pipeline health from CSV, Sheets, or CRM exports |

## Skills

| Skill | Description |
|---|---|
| `account-research` | Research a company or person with web search and optional CRM/enrichment context |
| `call-prep` | Build a prep brief from meeting metadata, email history, Drive notes, and company research |
| `daily-briefing` | Prioritized seller briefing using today’s meetings, inbox signals, and optional pipeline data |
| `draft-outreach` | Research-first outreach with Gmail draft creation when available |
| `competitive-intelligence` | Competitive research with optional Drive docs and CRM context |
| `create-an-asset` | Generate custom sales assets such as landing pages, decks, and one-pagers |

## Google Workspace-First Defaults

When tools are connected, these skills should prefer:

| Need | Default Source |
|---|---|
| Upcoming meetings | Google Calendar |
| Customer threads, follow-ups, transcript emails | Gmail |
| Notes, decks, proposals, transcript docs/files | Google Drive |
| Pipeline trackers and account spreadsheets | Google Sheets |
| Deal history and stage hygiene | CRM, when available |

Transcript handling in v1 is intentionally simple: search Gmail and Drive first for transcript artifacts tied to the account or meeting. Do not assume direct Google Meet transcript APIs are available.

## Example Uses

```text
Prep me for my call with Acme tomorrow
```

```text
/call-summary
```

```text
Start my day
```

```text
Draft an email to the VP of Engineering at TechStart
```

## Notes

- These skills are adapted for HelpUDoc and do not rely on Claude plugin installation metadata.
- CRM remains optional but still improves `forecast`, `pipeline-review`, and historical account context.
- If Google OAuth scopes expand, existing users need to sign in with Google again so Gmail, Calendar, Drive, and Sheets access can be delegated to MCP servers.
