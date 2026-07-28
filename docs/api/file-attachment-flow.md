# File and knowledge context flow

Workspace uploads and published knowledge are separate paths.

## Chat uploads

1. The client uploads a file with `POST /api/workspaces/:workspaceId/files`.
2. The backend writes the original file to the workspace and returns immediately.
3. The client includes the relative path in `taggedFiles` when starting an agent run.
4. The agent uses `search_document` and bounded `inspect_document` calls against the original file.

Uploads do not trigger background parsing, vector indexing, or generated copies. PDF, DOCX,
XLSX/XLSM, CSV, TSV, Markdown, and text files are inspected on demand. Images may also be sent
as current-turn multimodal content.

## Knowledge publication

Admin-selected sources use the knowledge API. Publication performs deterministic extraction and
writes an OKF bundle under `.system/knowledge/<knowledge-id>/`:

- `index.md` is the entry point.
- `concepts/*.md` contains progressively readable topics.
- `source.md` records the source.
- `log.md` records publication metadata.

The chat client adds a published bundle by its path. The agent starts with `knowledge_read` on
`index.md`, then uses `knowledge_search` and reads only relevant concept files.

## Agent run payload

```json
{
  "workspaceId": "workspace-id",
  "conversationId": "conversation-id",
  "persona": "fast",
  "prompt": "Summarize the renewal risks",
  "taggedFiles": ["contracts/customer-renewal.pdf"]
}
```

No readiness polling is required after an upload.
