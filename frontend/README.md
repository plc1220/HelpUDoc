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

Personal and shared workspaces support **Annotate** to highlight text or pin an HTML element, PDF page, or Office preview. Personal comments are private; shared comments notify workspace members. Replies and resolution stay with each thread.

Select several comments in the Comments panel, or select all, then add them to agent chat. Every selected thread includes the file, location, quoted passage, original comment, and full replies. This prepares one draft and retains existing composer text; the user reviews and sends it. If any thread fails to load, no incomplete batch is added. Comments refresh every 15 seconds.

Office preview annotations use the original file SHA and rendered page/slide anchors. After a file revision, old threads remain with their context while outdated highlights/pins are hidden. Text and HTML anchors reattach only when saved context matches.

## Office preview and native DOCX editing

- **Preview / Annotate:** DOCX/PPTX page previews use LibreOffice Writer/Impress to generate a PDF for display. Selecting text offers **Annotate**. The original Office file remains the download source.
- **Edit file:** DOCX opens the native OOXML editor from `@docx-editor.dev/react` (Apache 2.0), loading DOCX bytes directly. The compact toolbar exposes undo/redo, paragraph styles, font size, bold, and italic. Editing does not use the PDF or match PDF selections back to paragraphs. Annotations stay in preview mode.
- **Save:** The existing canvas Save button and Ctrl/Cmd+S save a new DOCX revision. Native edits use explicit save; text-editor autosave is excluded. Exiting Edit file saves first and stays open on failure. Source SHA and version are checked under the backend storage lock to prevent overwriting collaborator changes.
- Unsaved DOCX snapshots are retained in a bounded, user-scoped in-memory cache across canvas navigation. Conflicts preserve the draft and offer downloading local edits. Closing or reloading the tab can lose drafts, so a browser unload guard is used. Published versions, viewers, and protected documents stay read-only.
- Editor font support comes from the pinned font package. Layout can still differ from Word for missing fonts or unsupported features; the preview and native editor use different layout engines. Keep source version history and inspect complex templates after saving. Editor and bundled font notices are distributed at `/licenses/native-docx-editor.txt`.
- Preview failures show retry/download controls. The agent image needs Writer/Impress and bundled fonts. Native editor source/save endpoints do not depend on LibreOffice.
- Tests: `npm test`; native editor save/reopen/preservation tests use `NATIVE_DOCX_FIXTURE=/path/to/example.docx` with `e2e/native-docx-local.spec.ts` and `e2e/file-editor-docx-local.spec.ts`. Annotation batches use `e2e/annotation-batch-local.spec.ts`. Local Vite plus `E2E_BASE_URL=http://127.0.0.1:5173 npx playwright test e2e/office-quick-edit-local.spec.ts e2e/document-annotations-local.spec.ts`; real preview visuals additionally use `OFFICE_PREVIEW_FIXTURE=/path/to/fixture.json` and `e2e/office-preview-real-local.spec.ts`.

## Rendering notes

- HTML previews are sandboxed in an iframe.
- Markdown uses `react-markdown` with GFM support.
- Plotly and Mermaid are rendered client-side.

## Related docs

- [../README.md](../README.md)
- [../backend/README.md](../backend/README.md)
- [../docs/environment.md](../docs/environment.md)
