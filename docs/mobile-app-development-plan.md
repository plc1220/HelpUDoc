# Mobile App Development Plan

**Remote control for your AI workspace — artifact generation, long-running job notifications, and web/app alignment.**

Prepared: **February 19, 2026**

---

## 0) TL;DR
- **Web = Workbench** (deep work, configuration, review, editing)
- **Mobile = Remote Control** (trigger jobs, chat on the go, notifications, quick approvals, previews)
- **Platform**: **React Native + Expo**
- **Critical path**: **Refactor web first** to extract shared hooks/services/types; then build mobile in phases.
- **Non-negotiable**: notifications + deep links, so mobile is the first surface to tell users job status.

---

## 1) Product Philosophy

### 1.1 Two Surfaces, One Product
The web app and mobile app are **two surfaces of the same product**, not competing experiences. Each surface has a clear role.

#### 🖥️ Web — The Workbench
For deep, deliberate work:
- Examine artifacts on the canvas
- Edit files and review outputs
- Configure complex pipelines
- Manage workspaces and settings
- Approve HITL agent decisions with full context

#### 📱 Mobile — The Remote Control
For quick actions away from desk:
- Trigger artifact generation
- Chat with the agent on the go
- Get push notifications on job completion
- Quick-approve HITL decisions
- Preview results, then hand off to web

### 1.2 Design Principle
Mobile should feel like **the right tool for the situation**, not a “lite” web app.

---

## 2) Platform Decision

### Recommendation: **React Native + Expo**
This is the best fit given the codebase and goals.

| Option | Pros | Cons |
|---|---|---|
| **React Native + Expo ✅** | Shared hooks/types/services, Expo push notifications, TypeScript native, fast iteration | Not 100% native performance (irrelevant here) |
| PWA | No app store, shared web code | iOS push notifications unreliable, confusing install UX, weaker “app feel” |
| Native iOS + Android | Best performance and deep integration | Two codebases, longest time to market, no reuse of existing web logic |

---

## 3) Shared Architecture

### 3.1 Why This Works
The **web refactor** (extracting hooks + service layers) directly enables the mobile app.
**Code written once, used on both surfaces.**

### 3.2 Shared Layer (Extract from Web, Used by Both)
- `shared/services/`
  - `workspaceApi`, `fileApi`, `agentApi`, `conversationApi`, `paper2SlidesJobApi` (unchanged)
- `shared/types/`
  - TypeScript types: `Workspace`, `WorkspaceFile`, `AgentPersona`, `ConversationMessage`, `ToolEvent`, etc.
- `shared/hooks/`
  - `useAgentStream`, `useConversation`, `useFileManager`, `usePresentation`, `useA2ui`
- `shared/utils/`
  - `files.ts`, `messages.ts`, `personas.ts`, `a2ui.ts` (pure functions, no UI deps)

### 3.3 Mobile-Only Layer
- `mobile/screens/` — screens
- `mobile/components/` — React Native UI components
- `mobile/notifications/` — push token registration, handlers, deep link routing
- `mobile/navigation/` — React Navigation stack + tabs

### 3.4 Sequencing Rule (Important)
**Do the web refactor first.**  
Building mobile before extracting the shared layer will duplicate business logic.

**Estimate**: 2–3 weeks of refactor work before Mobile Phase 1.

---

## 4) Core Screens (Mobile)

### Navigation
Use a **bottom tab bar** (not hamburger). Three tabs cover ~90% of mobile use cases.

| Screen | Purpose & Key Interactions | Phase |
|---|---|---|
| Login / Auth | SSO or email login; reuse existing auth token flow; store credentials in `expo-secure-store` | P1 |
| Workspace Picker | Bottom sheet on first open if no default set; allow pinning default workspace | P1 |
| 💬 Chat (Primary Tab) | Full conversation thread; attachments; `/command` picker as keyboard accessory; `@mention` as bottom sheet; artifact-ready banner on job completion | P1 |
| 📋 Jobs Tab | Running/completed jobs list; status + workspace + trigger time; tap to open artifact or return to origin chat | P1 |
| 🖼️ Artifact Viewer | Bottom sheet/full-screen viewer for PDF/images/markdown; unsupported types show preview + **Open on desktop** deep link | P1 |
| Notification Tap → Deep Link | Tap notification routes to correct chat/artifact; handle foreground/background/killed-app | P2 |
| HITL Approval (Mobile) | Approve/edit/reject agent interrupt decisions; same API as web | P3 |
| 📁 Files Tab | Browse workspace files; view-only; open artifacts; download to device | P3 |
| Settings | Notification preferences, default workspace, sign out; permission management | P1 |

---

## 5) Notification Architecture (Most Important)

Notifications are the mechanism that enables users to confidently trigger long-running jobs and walk away.

### 5.1 End-to-End Flow
1. User triggers a job (Paper2Slides / agent run) from mobile or web  
2. Backend starts job and records the user’s registered push token  
3. Job completes / fails / requires approval  
4. Backend sends push via **FCM (Android)** and **APNs (iOS)** (through Expo)  
5. Payload includes: `jobId`, `workspaceId`, `conversationId`, `notificationType`  
6. User taps notification → app deep links to correct screen  
7. Web reflects same state (both surfaces read the same APIs)

### 5.2 Notification Types
| Event | Notification Text | Deep Link Destination |
|---|---|---|
| Paper2Slides complete | “Your slides for [file] are ready” | Artifact Viewer |
| Agent run complete | “Agent finished your task” | Chat thread |
| Agent needs approval | “Agent needs your input” | Chat + approval UI |
| Agent run failed | “Something went wrong” | Chat thread |

### 5.3 Backend Requirements (New Work)
- Push token registration endpoint (store token per user)
- On job completion/failure/approval-request: trigger notification with structured payload
- Payload must include: `jobId`, `workspaceId`, `conversationId`, `notificationType`
- No change required on web polling — both surfaces read same job status APIs

### 5.4 iOS Permission Rule
Do **not** request notification permission on app launch.  
Request only after the user starts their first long-running job (clear value prop).

---

## 6) Mobile UX Decisions (Deliberate Differences)

- **Workspace selection**: bottom sheet on first launch; skip if default workspace pinned; workspace switcher in chat header.
- **Artifact banner**: non-blocking banner in Chat when a job finishes mid-session.
- **/command picker**: keyboard accessory bar (above keyboard).
- **@mention picker**: full bottom sheet (more space; avoids keyboard layout issues).
- **Open on desktop escape hatch**: for A2UI canvas / interactive HTML — show simplified preview + deep link.
- **Offline handling**: show clear offline indicator; queue outbound messages and send on reconnect; never fail silently.
- **State preservation**: hide (don’t unmount) Chat tab to preserve drafts, scroll, and session state.

### What NOT to Build Initially (Intentional Omissions)
- File editor / code editing
- A2UI canvas interaction
- Full Paper2Slides option configuration
- Workspace management (create/delete)
- Multi-file selection

These reinforce “remote control” positioning.

---

## 7) Phased Delivery

Each phase ships a complete usable product.

### Pre-work (Web Refactor) — **2–3 weeks**
- Extract shared hooks: `useAgentStream`, `useConversation`, `useFileManager`
- Extract shared service + util layers
- Set up monorepo/shared package structure
- Validate shared code compiles for React Native target

### Phase 1 (Core Loop) — **6–8 weeks**
- Auth (reuse flow; store tokens in `expo-secure-store`)
- Workspace selection + default pinning
- Full chat with agent (send, stream, view responses)
- Basic artifact viewer (PDF/images/markdown)
- Jobs tab with manual pull-to-refresh
- Settings screen + sign out

### Phase 2 (Notifications) — **3–4 weeks**
- Push infra (FCM + APNs via Expo)
- Backend: push token registration endpoint
- Backend: job completion + approval triggers
- Deep linking: notification tap → correct screen
- Foreground in-app banner for completions
- Notification preferences in Settings

### Phase 3 (Key-Flow Parity) — **4–6 weeks**
- HITL approval from mobile (approve/edit/reject)
- `/presentation` command with sensible mobile defaults
- File browser (view-only + download)
- Conversation history + session switching
- “Open on desktop” deep link generation for unsupported artifacts

### Phase 4 (Polish) — Ongoing
- Offline message queue with reconnect send
- Default workspace auto-selection + pinning UX
- Performance profiling & cold start optimization
- Accessibility audit (VoiceOver/TalkBack)
- App Store / Play Store submission preparation

---

## 8) Technical Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| SSE streaming (`useAgentStream`) | High | RN has no native `EventSource`; use polyfill or refactor to chunked fetch with manual reader. **Test in P1 week 1.** |
| iOS push reliability | High | APNs certs are env-specific/expire. Use Expo managed credentials; avoid manual cert handling. |
| Virtual keyboard + chat input | Medium | iOS viewport shifts can break fixed inputs. Handle `visualViewport` resize; test on physical devices. |
| File download/viewing | Medium | Use `expo-file-system` + `expo-sharing`; PDFs likely need `react-native-pdf`. Budget extra time. |
| Auth token across web + mobile sessions | Medium | Refresh rotation must handle concurrent sessions. Use `expo-secure-store`; explicitly test concurrent refresh. |
| `body { overflow: hidden }` pattern | Low | Don’t carry web layout patterns to mobile; it breaks iOS momentum scrolling. |

---

## 9) Definition of Success

After Phase 2, a user can:
1. Open app → choose workspace → ask agent to generate slides from a tagged file
2. Put phone away
3. Receive push when job completes
4. Tap notification → preview slides PDF
5. Approve follow-up HITL decision waiting on user input
6. Later return to desktop for full canvas review

### Litmus Test
If a user must open the web app just to know whether a mobile-triggered job succeeded, **notifications failed**.

---

## 10) Codex Execution Plan (Actionable Backlog)

> Use this section as the handoff to Codex: concrete tasks, acceptance criteria, and sequencing.

### 10.1 Repo / Package Structure
**Goal**: introduce a shared package usable by web + mobile.

Tasks:
- Create `packages/shared/` (or equivalent) with:
  - `services/`, `types/`, `hooks/`, `utils/`
- Add build/tsconfig references so:
  - web imports from `packages/shared`
  - mobile imports from `packages/shared`
- Ensure no React DOM / browser-only deps leak into shared code.

Acceptance:
- Web builds and runs using imports from shared.
- A minimal RN “hello screen” can import shared `types` and `utils` successfully.

### 10.2 Web Refactor (Pre-work)
Tasks:
- Move API clients into `shared/services/*`
- Move TS types into `shared/types/*`
- Move business hooks into `shared/hooks/*` (no UI)
- Replace web local imports to shared imports
- Add unit tests for key utils (optional but recommended)

Acceptance:
- No duplicated business logic remains in web UI components.
- Shared layer has **zero** `window/document` usage.
- `useAgentStream` is abstracted for RN compatibility.

### 10.3 Mobile App Skeleton (Phase 1)
Tasks:
- Expo RN app setup + TS
- Auth flow: reuse tokens; store in `expo-secure-store`
- Bottom tabs: Chat / Jobs / (Settings)
- Workspace picker bottom sheet + pin default workspace
- Chat thread + composer; attachments wiring (if supported by APIs)
- Streaming: implement `useAgentStream` solution (polyfill or chunked fetch)
- Artifact viewer: PDF/images/markdown
- Jobs list: pull-to-refresh; navigate to artifact or chat

Acceptance:
- User can login, pick workspace, chat with agent, and view artifacts.
- A long-running job appears in Jobs and can be opened from there.

### 10.4 Notifications + Deep Links (Phase 2)
Backend tasks:
- Push token registration endpoint
- Job lifecycle hooks → send push (complete/fail/needs approval)
- Standardize payload schema

Mobile tasks:
- Expo push token registration + refresh handling
- Notification listeners (foreground/background/killed)
- Deep link router: job → artifact, approval → chat + approval UI
- Settings: notification preferences + permission prompt timing

Acceptance:
- Completing a job triggers a push; tap routes to correct content.
- Foreground banner shows when user is inside Chat and job completes.

### 10.5 HITL Approval (Phase 3)
Tasks:
- Fetch pending approvals list (or integrate into Chat flow)
- Approval UI: approve/edit/reject + feedback input
- Same API contract as web

Acceptance:
- User can resolve an approval entirely from mobile; web reflects status.

---

## 11) Prompt to Give Codex (Copy/Paste)

```text
You are Codex working inside this repository.

Goal: Implement the Mobile App plan in this document with correct sequencing:
(1) Extract shared types/services/hooks/utils from the web app into packages/shared
(2) Build an Expo React Native app that uses the shared layer
(3) Add push notifications + deep links for job completion and HITL approvals

Constraints:
- Do the web refactor first; do not duplicate business logic in mobile.
- Shared code must be platform-safe (no window/document).
- Streaming: React Native has no EventSource; implement a compatible solution early.
- Keep mobile scope aligned to “remote control” positioning (no editors or canvas interaction initially).

Deliverables:
- A PR that introduces packages/shared and migrates web to use it
- A PR that adds the Expo RN app with Chat/Jobs/Artifact Viewer/Settings
- A PR that adds push notifications infrastructure and deep-link routing

Follow the backlog in section 10 (Codex Execution Plan) and include acceptance checks in PR descriptions.
```
