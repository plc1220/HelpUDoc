# Connectors

## Operating Model

Sales skills in HelpUDoc should not treat connectors as interchangeable abstractions. Prefer the concrete tools that exist today and follow this source order:

1. Google Workspace internal context
2. Tagged workspace files and internal documents
3. Google Search for current external context
4. CRM and enrichment data when available

If a user tagged files, use `rag_query` first before broad web search.

## Recommended Connector Mapping

| Need | Placeholder | Preferred source | Typical actions |
|---|---|---|---|
| Upcoming meeting context | `~~calendar` | Google Calendar | Find meeting, attendees, description, timing |
| Customer thread history and drafts | `~~email` | Gmail | Search messages and threads, inspect recap emails, create drafts |
| Notes, decks, proposals, transcripts | `~~knowledge base` | Google Drive | Search docs/files, find prior materials, pull recap artifacts |
| Trackers and planning sheets | `~~spreadsheet data` | Google Sheets | Look up account plans, pipeline rows, next-step trackers |
| Internal tagged files | n/a | Workspace files via `rag_query` | Use tagged docs before broad search |
| External market/account updates | n/a | `google_search` | Research current news, industry shifts, competitor updates |
| Deal history and hygiene | `~~CRM` | HubSpot, Salesforce, Close, etc. | Pull stage, opp history, contacts, tasks |
| Contact validation and firmographics | `~~data enrichment` | Clay, ZoomInfo, Apollo | Enrich contacts and account details |
| Internal field chatter | `~~chat` | Slack or Teams | Pull deal chatter or field intel only when relevant |
| Competitive research | `~~competitive intelligence` | Drive docs plus web research | Reuse internal battlecards, then enrich externally |

## Transcript Guidance

For v1, transcript lookup should search:

1. Gmail for transcript or recap emails
2. Google Drive for transcript docs, notes, or recording metadata
3. Calendar details to disambiguate the correct meeting
4. CRM or conversation-intelligence tools only if they are actually connected

Do not assume direct Google Meet transcript APIs are available.

## Handoff Guidance

Sales skills should gather enough structured context before handing off to downstream workflows:

- `research` for deeper external account, market, or industry analysis
- `proposal-writing` for proposals, SOWs, or commercial documents
- `frontend-slides` for decks, QBRs, or executive presentations
- `create-an-asset` for customer-facing one-pagers, landing pages, or demo assets

The handoff artifact should usually capture:

- company and meeting context
- key contacts and roles
- goals, pain points, and objections
- current deal or account status
- source-backed notes and unresolved questions
