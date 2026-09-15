# HelpUDoc Frontend

The frontend is a React 19 + Vite application that powers the main HelpUDoc user experience.
It currently includes:

- authenticated workspace access
- file browsing, editing, and rendering
- streaming agent chat with approvals and interrupt actions
- settings pages for agent configuration, skills, users, and operations surfaces

## Prerequisites

- Node.js 20+
- npm

## Installation

```bash
cd frontend
npm install
```

## Environment variables

The app reads Vite-style `VITE_*` variables from your shell, `.env.local`, or Docker build args.

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `VITE_API_URL` | `http://localhost:3000/api` | Base URL for backend API calls in local development. |
| `VITE_AUTH_MODE` | `hybrid` | Matches backend auth mode and controls login behavior. |
| `VITE_GOOGLE_CLIENT_ID` | unset | Enables Google sign-in UI when provided. |
| `VITE_DEBUG_STREAM` | unset | Enables extra client-side stream debugging helpers. |

## Running locally

```bash
npm run dev
```

Vite dev server: `http://localhost:5173`

## Available scripts

```bash
npm run dev
npm run build
npm run build:docker
npm run lint
npm run preview
npm run e2e:install
npm run e2e
```

## App structure

| Path | Purpose |
| ---- | ------- |
| `src/auth/` | Auth provider and persisted auth state. |
| `src/pages/` | Thin route entry-points; the workspace route re-exports `features/workspace/WorkspacePage`. |
| `src/features/` | Feature modules that own their components, hooks, and utilities. See the feature map below. |
| `src/components/` | Cross-cutting/legacy components that have not yet been pulled into a feature module. Some sub-paths (`dashboard/`, `settings/`, `chat/approvalReview`, `chat/interruptActions`, `chat/chatTypes`) are kept as re-export shims pointing at `features/` and will be removed once consumers migrate. |
| `src/services/` | API clients for workspaces, files, conversations, agent runs, settings, and auth-aware fetches. |
| `src/constants/` | Shared UI constants such as slash commands. |
| `src/utils/` | File, message, and rendering helpers. |

### Feature modules

| Feature | Path | Owns |
| ------- | ---- | ---- |
| Workspace | `src/features/workspace/` | `WorkspacePage` route component, workspace-path helpers (`utils/workspacePaths.ts`). |
| Chat | `src/features/chat/` | Chat composer/interrupt contracts: `types.ts`, `interrupts/approvalReview.ts`, `interrupts/actions.ts`. |
| Dashboard | `src/features/dashboard/` | `DashboardCanvas`, `DashboardFilters`, and snapshot-download helper. |
| Settings | `src/features/settings/` | Settings shell/scaffold and admin tabs (`AgentSettingsTabs`, `ToolsTab`, `SkillsRegistryTab`, `SkillEvolutionTab`). |

Hook extraction and the full `ChatMessageBubble` split (tool events, interrupt card, artifact preview) are tracked as follow-up cleanup work.

## Routing

The current route map is:

- `/login` -> login page
- `/` -> authenticated workspace
- `/settings` -> dashboard overview
- `/settings/agents` -> agent config and skills tools
- `/settings/knowledge` -> knowledge/settings surface
- `/settings/users` -> user management surface
- `/settings/billing` -> billing placeholder surface

Unauthenticated users are redirected to `/login`.

## Core user flows

### Workspace and files

The workspace page combines:

- workspace list and selection
- file list with type-aware icons
- Monaco or markdown editing depending on file type
- rich rendering for markdown, HTML, images, PDFs, CSV, Plotly JSON, and Mermaid diagrams

### Agent runs

The frontend talks to the backend's run APIs to support:

- starting runs and streaming assistant output
- approval and clarification interrupts
- run cancellation and resume flows
- slash-command metadata discovery
- conversation history persistence

### Settings and admin tools

The settings API client supports:

- editing `runtime.yaml`
- browsing and editing bundled skills
- GitHub skill import flows
- skill-builder sessions with streamed runs
- user and group administration

## Canvas annotations

In a Shared workspace, use **Annotate** to highlight text (including source-editor selections) or click an HTML preview element to place a pin. Comments persist with the file and support replies and resolution. Other workspace members receive an inbox notification that opens the file and thread. Private comments do not notify other members.

**Add to agent chat** opens the agent composer with the file, selected passage or element, comment, and replies. Review and send the prepared message to invoke the agent. Existing composer text is preserved. Comments and replies refresh every 15 seconds. PDF previews support selectable-text highlights and page pins (including scanned pages). DOCX and PPTX files render through the server’s Office-to-PDF converter, retaining page and slide layout; comments use the same PDF text layer and page/slide pins. Office anchors use the original file’s SHA revision, so regenerating an unchanged PDF does not invalidate them. After a document edit, older revision annotations remain in the comments panel with their quoted context but their highlights/pins are hidden. Other text anchors reattach only to an exact saved position or a unique matching passage; HTML pins are hidden if their element no longer matches the saved text.

## Office previews and quick edits

- DOCX/PPTX previews use LibreOffice Writer/Impress in the agent runtime, cached by source SHA and renderer version. Pages retain the document’s colors/fonts while Astryx themes the surrounding controls. The original DOCX/PPTX remains the download and editing source; it is never rebuilt from preview HTML or PDF.
- In an editable DOCX, select text to open **Quick edit**: bold, italic, font size, uploaded paragraph style, selected-text replacement, comment, and agent handoff. Applying a style changes the containing paragraph. Replacement text inherits the first selected run’s formatting; surrounding runs retain theirs. **Undo last edit** is available only while the saved revision remains current and belongs to that user.
- The API maps exact Unicode codepoint ranges to the original DOCX XML. Duplicate matches are never guessed; short/generated-field selections require an explicit source-passage choice. Nonbody text, complex fields, hyperlinks, drawings, tracked/protected documents, and unsafe selections remain read-only. Users can still annotate them or prepare an agent request. Font/text changes can naturally reflow pages.
- Saves validate both source SHA and file version, including a second version check under the storage lock. A concurrent agent/collaborator edit leaves the user's typed correction open and asks them to refresh. Published snapshots and viewers always remain read-only.
- Converter failures show an explicit retry/download state; no approximate HTML fallback silently replaces the page view. The agent image needs Writer/Impress and the bundled font packages. Exact Word fidelity still depends on font availability and Office layout compatibility.
- Tests: `npm test`; local Vite + `E2E_BASE_URL=http://127.0.0.1:5173 npx playwright test e2e/office-quick-edit-local.spec.ts e2e/document-annotations-local.spec.ts`; optional real-layout visual test with `OFFICE_PREVIEW_FIXTURE=/path/to/fixture.json` and `e2e/office-preview-real-local.spec.ts`.

## Rendering notes

- HTML previews are sandboxed in an iframe.
- Markdown uses `react-markdown` with GFM support.
- Plotly and Mermaid are rendered client-side.

## Related docs

- [../README.md](../README.md)
- [../backend/README.md](../backend/README.md)
- [../docs/environment.md](../docs/environment.md)
