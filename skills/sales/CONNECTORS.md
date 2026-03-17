# Connectors

## How placeholders work

These skills use placeholders such as `~~calendar` or `~~email` to refer to whichever MCP tools are connected in that category. In HelpUDoc, the preferred default for most seller workflows is Google Workspace.

## Recommended connector mapping

| Category | Placeholder | Preferred source | What it adds |
|----------|-------------|------------------|--------------|
| Calendar | `~~calendar` | Google Calendar | Upcoming meetings, attendees, meeting descriptions |
| Email | `~~email` | Gmail | Customer threads, unread priorities, Gmail draft creation |
| Knowledge base | `~~knowledge base` | Google Drive | Notes, decks, proposals, transcript docs/files |
| Spreadsheet data | `~~spreadsheet data` | Google Sheets | Pipeline trackers, account plans, export sheets |
| CRM | `~~CRM` | HubSpot, Salesforce, Close, etc. | Deal history, stage, tasks, account records |
| Data enrichment | `~~data enrichment` | Clay, ZoomInfo, Apollo | Verified contact data and firmographics |
| Chat | `~~chat` | Slack or Teams | Internal seller chatter and account intel |
| Competitive intelligence | `~~competitive intelligence` | Similarweb or docs | Market and competitor context |

## Transcript guidance

For v1, transcript lookup should search:

1. Gmail for transcript emails or meeting recap threads
2. Google Drive for transcript documents, notes, or recordings metadata
3. CRM or conversation-intelligence tools only if those are connected

Do not assume direct Google Meet transcript APIs are available.
