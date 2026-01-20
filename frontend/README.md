# HelpUDoc Frontend

The frontend is a React + Vite application that provides the collaborative workspace UI, editors, and data visualizations for HelpUDoc.

## Getting started

### Prerequisites

- Node.js 20.x
- npm (or yarn)

### Installation

```bash
cd frontend
npm install
```

### Environment variables

Create or update `frontend/.env` with:

- `VITE_API_URL` (default: `http://localhost:3000/api`)
- `VITE_COLLAB_URL` (default: `ws://localhost:1234`)
- `VITE_GOOGLE_CLIENT_ID` (optional, for Google auth)

### Running the application

```bash
npm run dev
```

The dev server will be available at `http://localhost:5173` by default.

## Project structure

```
src/
├── auth/                 # Local + Google auth state and helpers
├── components/           # Reusable UI widgets and app chrome
│   └── settings/         # Settings pages tabs + shell
├── pages/                # Route-level screens
├── services/             # API clients and HTTP helpers
├── index.css             # Tailwind entry + theme variables
├── theme.ts              # Theme helpers for charts or UI
├── types.ts              # Shared frontend types
├── App.tsx               # Route definitions and auth guard
└── main.tsx              # App bootstrap
```

## Routing overview

- `main.tsx` wraps the app with `AuthProvider` and `BrowserRouter`.
- `App.tsx` defines all routes and enforces auth gating through `RequireAuth`.

Routes:
- `/` → Workspace experience (`WorkspacePage`)
- `/login` → Login and onboarding (`LoginPage`)
- `/settings/*` → Admin/settings portal (`DashboardPage`, `AgentSettingsPage`, `KnowledgePage`, `UsersPage`, `BillingPage`)

## Component guide

### Workspace + file experience

- `components/CollapsibleDrawer.tsx`
  - Left drawer housing workspace list, create controls, and appearance toggle.
  - Bridges settings navigation and sign-out actions.
- `components/ExpandableSidebar.tsx`
  - Compact sidebar shown when the drawer is collapsed.
  - Provides quick access to workspace drawer and settings.
- `components/WorkspaceList.tsx`
  - Workspace list with selection and delete actions.
- `components/FileList.tsx`
  - File list with icon inference for markdown, images, PDFs, HTML, etc.
- `components/FileEditor.tsx`
  - Monaco editor for code/text files and MDXEditor for markdown files.
  - Provides lightweight formatting toolbar for non-markdown files.
- `components/FileRenderer.tsx`
  - Viewer for markdown, HTML, images, PDFs, CSV, Plotly specs, and Mermaid diagrams.
  - Supports Markdown rendering with `react-markdown` + GFM, CSV tables via PapaParse, Plotly JSON charts, and Mermaid rendering (with copy-to-image support).
- `components/PlotlyChart.tsx`
  - Thin wrapper around `react-plotly.js` to render Plotly charts responsively.

### Agent settings portal

- `components/settings/SettingsShell.tsx`
  - Shared layout for the settings portal, including left nav and header.
- `components/settings/AgentSettingsTabs.tsx`
  - Tab switcher for core agents, subagents, and tools configuration.
- `components/settings/CoreAgentsTab.tsx`
  - Editor for core agent personas and prompt/tool configuration.
- `components/settings/SubagentsTab.tsx`
  - Editor for subagent definitions and wiring.
- `components/settings/ToolsTab.tsx`
  - Configuration UI for tools and MCP servers.

### Auth

- `auth/AuthProvider.tsx`
  - Central auth state and helpers (Google OAuth or local email login).
- `auth/authStore.ts`
  - Local storage persistence for `AuthUser` (used to supply identity headers).

## Pages

- `pages/WorkspacePage.tsx`
  - Main workspace experience: drawers, file list/editor, agent chat, and run status.
  - Integrates file CRUD, agent runs, and conversation history.
- `pages/LoginPage.tsx`
  - Login experience with Google OAuth and local email login fallback.
- `pages/DashboardPage.tsx`
  - Overview for settings/operations status.
- `pages/AgentSettingsPage.tsx`
  - Hosts `AgentSettingsTabs` inside the settings shell.
- `pages/KnowledgePage.tsx`, `pages/UsersPage.tsx`, `pages/BillingPage.tsx`
  - Placeholder pages for future management surfaces.

## Services

API helpers live in `src/services/` and share a common wrapper:

- `apiClient.ts` sets `API_URL` and injects identity headers (`X-User-*`) from `authStore`.
- `workspaceApi.ts`, `fileApi.ts`, `knowledgeApi.ts`, `presentationApi.ts`, `conversationApi.ts` provide CRUD helpers.
- `agentApi.ts` supports agent runs (including streaming updates and cancellation).
- `paper2SlidesJobApi.ts` triggers and polls the paper-to-slides pipeline.
- `settingsApi.ts` fetches/saves agent configuration YAML.

## Styling & theming

- Tailwind is used for utility styles (`index.css` bootstraps base + utilities).
- CSS variables in `index.css` drive light/dark themes and normalize frequently used Tailwind color classes.
- MUI components are used for the workspace shell and lists (see `WorkspacePage.tsx` and drawer components).

## API references

- OpenAPI contract: `docs/specs/001-a-custom-ui/contracts/openapi.yaml`
- The frontend assumes the backend API is available at `/api` in Docker, or at `VITE_API_URL` in local dev.

## Notes on file rendering

`FileRenderer.tsx` uses an iframe for `.html` previews. The sandbox allows `allow-scripts allow-same-origin` so embedded Plotly/Chart.js content can execute while still isolating the preview from the parent page.
