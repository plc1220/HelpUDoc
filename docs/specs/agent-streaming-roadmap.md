# HelpUDoc Agent Streaming UX Roadmap (LangGraph `astream`)

This roadmap targets the current HelpUDoc architecture:

- Python agent service (`agent/helpudoc_agent/app.py`) exposes JSONL streaming: `POST /agents/{persona}/workspace/{workspace}/chat/stream`
- Node/Express backend proxies streaming: `POST /api/agent/run-stream` (`backend/src/api/agent.ts`)
- React/Vite frontend consumes JSONL via `fetch().body.getReader()` (`frontend/src/services/agentApi.ts`) and updates UI per-token (`frontend/src/pages/WorkspacePage.tsx`)
- Redis is available and connected (`backend/src/services/redisService.ts`, `backend/src/index.ts`)

---

## Goals

1. UI never “sticks” or becomes hard to navigate while the agent runs.
2. Runs can keep going if the user navigates away (optional but recommended).
3. User can resume/reattach to an in-progress run after navigation/reload.
4. Backend doesn’t waste compute when the client disconnects.
5. Conversation history persists reliably.

---

## Current architecture (baseline)

**Today**

- Frontend calls `/api/agent/run-stream` and awaits a long-lived stream.
- Backend proxies the upstream Python JSONL stream.
- Frontend updates React state per token → heavy rerender pressure and UI jank.
- On navigation/unmount, frontend aborts → backend can keep streaming from Python → wasted compute + no resumability.

---

## Roadmap overview (phases)

- **Phase 0: Immediate stabilization (1–2 days)**  
  Reduce UI jank, fix upstream cancellation, remove noisy logging.
- **Phase 1: Decouple execution from UI (2–5 days)**  
  Introduce `runId`, background execution, Redis Streams as event store, resumable streaming endpoint.
- **Phase 2: Persist “in-flight” messages + resume (2–4 days)**  
  Tie run lifecycle to `conversation_messages` with `turnId` + metadata; reconnect after reload.
- **Phase 3: Quality, scaling, observability (ongoing)**  
  Backpressure, retention, multi-instance scaling, metrics, auth improvements for SSE.

Each phase is independently shippable, but Phase 0 is strongly recommended before Phase 1.

---

# Phase 0 — Immediate stabilization (ship first)

## 0.1 Throttle/batch token rendering in React (largest UX win)

**Problem**
- `updateMessagesForConversation(...)` runs per token; this triggers frequent rerenders of a large page.

**Outcome**
- Render updates at most ~10–20 times/second (or per animation frame), not per token.

**Implementation (frontend)**
- Add a token buffer (per conversation + message) using a `useRef`.
- When a `token` chunk arrives, append to the buffer only.
- Flush the buffer into React state on a timer (`setInterval(50–100ms)`) or `requestAnimationFrame`.
- Keep tool/thought events immediate (low frequency).

**Where**
- `frontend/src/pages/WorkspacePage.tsx` (`handleStreamChunk(...)`, `appendAgentChunk(...)`)

**Acceptance checks**
- Navigation remains responsive while streaming.
- CPU usage drops during long responses.
- Typing/clicking UI elements remains smooth while streaming.

---

## 0.2 Stop logging every chunk

**Problem**
- Logging per chunk adds overhead (especially in dev).

**Implementation**
- Remove per-chunk log, or gate it behind a flag (e.g. `VITE_DEBUG_STREAM=1`).

**Where**
- `frontend/src/services/agentApi.ts`

---

## 0.3 Cancel upstream stream when client disconnects (backend must-have)

**Problem**
- Client aborts the fetch, but Node keeps reading from the Python stream unless explicitly aborted.

**Implementation (backend)**
- In `POST /api/agent/run-stream`:
  - Create an `AbortController`.
  - Pass `signal` into the axios request.
  - Abort when the client disconnects: `req.on('close', ...)` and/or `res.on('close', ...)`.
- Ensure the axios stream error/close path ends the Express response cleanly.

**Where**
- `backend/src/api/agent.ts` (`/run-stream`)
- `backend/src/services/agentService.ts` (`runAgentStream(...)` should accept a signal)

**Acceptance checks**
- Start a stream, then navigate away/abort → upstream stops quickly (verify via Python logs / reduced compute).
- Node does not keep an open upstream connection after client disconnect.

---

## 0.4 Reduce file polling frequency during stream (optional)

**Problem**
- While streaming, frontend polls files every 3 seconds; this adds load and can contribute to UI churn.

**Implementation**
- Increase interval during streaming (e.g. 10–15s), or refresh only at the end of the run.

**Where**
- `frontend/src/pages/WorkspacePage.tsx` interval effect around `loadFilesForWorkspace(...)`

---

**Phase 0 deliverable**
- No API behavior changes required.
- Users can stream long answers without UI feeling stuck.
- Aborting a stream actually stops backend work.

---

# Phase 1 — Decouple execution from UI (Run IDs + Redis Streams)

This phase implements an MQ-like architecture using Redis Streams (Redis is already in your stack).

## 1.1 Add a run model (conceptual)

Define a “run” as:
- `runId` (UUID)
- `workspaceId`
- `conversationId`
- `turnId`
- `persona`
- `userId`
- `status`: `queued | running | completed | failed | cancelled`
- timestamps

Store in Redis for the fast path; optionally mirror to DB later.

---

## 1.2 Add new backend endpoints (Node)

### Endpoint A — Start run (returns immediately)
`POST /api/agent/runs`

Request body:
```json
{
  "workspaceId": "...",
  "persona": "...",
  "prompt": "...",
  "history": [...],
  "conversationId": "...",
  "turnId": "..."
}
```

Response:
```json
{ "runId": "uuid", "status": "queued" }
```

Behavior:
- Validate workspace membership (same as current `/run-stream`).
- Create `runId`.
- Write run metadata to Redis.
- Fire-and-forget a background execution worker (see 1.3).
- Return immediately.

---

### Endpoint B — Stream events for a run (resumable)

Two approaches:

**Option 1 (recommended initially): JSONL over fetch**
- `GET /api/agent/runs/:runId/stream` with `Content-Type: application/jsonl`
- Client uses your existing `fetch + reader.read()` parser
- Works with your current header-based auth (`X-User-*`)

**Option 2: SSE**
- `GET /api/agent/runs/:runId/sse`
- Requires auth adjustments (EventSource can’t set custom headers; see Phase 3)

Recommendation: ship Option 1 first.

---

### Endpoint C — Status / metadata
- `GET /api/agent/runs/:runId` → status + timestamps + error (if any)

---

### Endpoint D — Cancel run
- `POST /api/agent/runs/:runId/cancel`
- Mark cancelled and abort upstream agent call.

---

## 1.3 Implement the run worker in Node (background)

Worker responsibilities:
1. Call Python: `POST /agents/{persona}/workspace/{workspaceId}/chat/stream`
2. Read JSONL chunks
3. Write each chunk into Redis Streams (and optionally into DB in Phase 2)

**Redis keys**
- Stream: `agent:run:{runId}`
- Meta: `agent:run:{runId}:meta`

**Write events**
- `XADD agent:run:{runId} * data "<json>"`

**Read events in `/stream` endpoint**
- `XREAD BLOCK 10000 STREAMS agent:run:{runId} {lastId}`
- Return each entry as one JSONL line.

**Retention**
- Apply TTL (e.g. 1–24 hours):
  - `EXPIRE agent:run:{runId} 86400`
  - `EXPIRE agent:run:{runId}:meta 86400`

**Multi-instance note**
- Single backend instance: fire-and-forget is fine.
- Multi-instance: use a real queue/worker (BullMQ, etc.) or a claim mechanism per run.

---

## 1.4 Preserve tool/artifact metadata

Your Python stream already emits UI-friendly events:
- `token`, `thought`, `tool_start`, `tool_end`, `tool_error`, `done`, `error`

Keep payloads as-is so the frontend can reuse the existing `AgentStreamChunk` union.

---

**Phase 1 deliverable**
- UI no longer depends on the agent execution request lifecycle.
- User can disconnect/reconnect and still see progress (replayable from Redis).
- Runs become resumable and cancellable.

---

# Phase 2 — Persist in-flight results into conversations (DB integration)

Phase 1 gives you resumable streams; Phase 2 makes the conversation record resilient.

## 2.1 Create an agent placeholder message immediately

On user send:
- Persist the user message (already implemented).
- Create an agent placeholder message:
  - `sender=agent`
  - `turnId` = the user’s `turnId`
  - `text=""`
  - `metadata: { runId, status: "running" }`

Your API already supports `turnId`, `replaceExisting`, and `metadata`.

---

## 2.2 Periodically flush to DB during streaming

In the run worker:
- Accumulate tokens into a buffer.
- Every 250–500ms (or on tool events), call:
  - `appendMessage(..., replaceExisting: true, turnId, text, metadata)`

This enables “reload mid-stream” and still seeing progress via DB.

---

## 2.3 Finalize on done

On `done`:
- Mark run status `completed`.
- Persist final text and metadata/tool events.

---

## 2.4 Reattach on frontend

When opening a conversation:
- If the newest agent message metadata indicates `{ status: "running", runId }`:
  - auto-subscribe to `/api/agent/runs/:runId/stream` and continue rendering

---

**Phase 2 deliverable**
- Reload/navigation doesn’t lose work.
- Conversation contains live-updating agent output.
- Better reliability and user trust.

---

# Phase 3 — Scaling, robustness, observability (after core UX works)

## 3.1 SSE auth (optional)

If you want native `EventSource`:
- Move auth to cookie sessions (`credentials: 'include'`) and ensure backend user context can rely on `req.session` when headers are absent, or
- Use a short-lived signed token for SSE URLs.

With the current header-based auth, JSONL over fetch is the simplest long-term path.

---

## 3.2 Backpressure + large output safeguards
- Cap per-run buffer sizes.
- Enforce max runtime and/or max tokens.
- Add truncation or pagination strategy for extremely long outputs.

---

## 3.3 Crash recovery
- If backend restarts mid-run: mark run failed after timeout unless resumed.
- Heartbeats in Redis meta help detect stuck runs.

---

## 3.4 Metrics/observability
- time-to-first-token
- tokens/sec
- tool latency
- cancel rate
- run success rate
- reconnect count

---

## 3.5 Multi-instance support
- Move the run worker to a separate worker process.
- Use BullMQ/Redis queue, NATS, or similar to dispatch runs.
- Keep Redis Streams as the event log for replay.

---

# Suggested order of work (concrete checklist)

## Week 1 (fast UX improvements)
- [x] Throttle token UI updates (buffer + ~75ms flush in `WorkspacePage`)
- [x] Remove/gate per-chunk console logs (guarded by `VITE_DEBUG_STREAM`)
- [x] Abort upstream Python stream on client disconnect (AbortController + axios signal)
- [x] Tune/disable file polling during stream (12s poll while streaming)

## Week 2 (runId + Redis Streams MVP)
- [x] Add `POST /api/agent/runs` (returns `runId`)
- [x] Implement run worker: Python stream → Redis Streams
- [x] Add `GET /api/agent/runs/:runId/stream` (JSONL)
- [x] Add status + cancel endpoints
- [x] Keep existing `/api/agent/run-stream` for backward compatibility

## Week 3 (persistence + resume)
- [x] Create agent placeholder message at run start
- [x] Periodically flush agent text (replaceExisting) with runId/status metadata
- [x] Auto-reattach on conversation open if run still running (resume via runId + metadata)

## Later
- [ ] SSE auth improvements (optional)
- [ ] Metrics + scaling improvements

---

# Notes specific to this repo

- The Python JSONL format is already UI-friendly; preserve it end-to-end.
- You already have a “job pattern” in `backend/src/services/paper2SlidesJobService.ts`; use it as a reference for “start immediately, track status, poll/stream updates”.
- `backend/src/services/conversationService.ts` already supports `turnId` + `replaceExisting` + `metadata`, which is ideal for progressive persistence.
