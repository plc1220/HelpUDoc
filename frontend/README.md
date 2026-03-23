# HelpUDoc Frontend

The frontend is a React 19 + Vite application that powers the main HelpUDoc user experience.
It currently includes:

- authenticated workspace access
- file browsing, editing, and rendering
- streaming agent chat with approvals and interrupt actions
- paper-to-slides job creation and export flow
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
| `VITE_COLLAB_URL` | `ws://localhost:1234` | Collaboration WebSocket endpoint. |
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
| `src/pages/` | Route-level screens like workspace, login, dashboard, and settings pages. |
| `src/components/` | Workspace UI, chat UI, file rendering, markdown helpers, and settings widgets. |
| `src/services/` | API clients for workspaces, files, conversations, agent runs, paper-to-slides, settings, and auth-aware fetches. |
| `src/constants/` | Shared UI constants such as slash commands and paper-to-slides presets. |
| `src/utils/` | File, message, and rendering helpers. |

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

### Paper-to-slides

The workspace page also exposes the paper-to-slides workflow, including:

- job creation
- job polling
- stage/status display
- PDF/PPTX export handoff

### Settings and admin tools

The settings API client supports:

- editing `runtime.yaml`
- browsing and editing bundled skills
- GitHub skill import flows
- skill-builder sessions with streamed runs
- user and group administration

## Rendering notes

- HTML previews are sandboxed in an iframe.
- Markdown uses `react-markdown` with GFM support.
- Plotly and Mermaid are rendered client-side.
- Collaboration uses Hocuspocus/Yjs via `@hocuspocus/provider`.

## Related docs

- [../README.md](../README.md)
- [../backend/README.md](../backend/README.md)
- [../docs/environment.md](../docs/environment.md)
