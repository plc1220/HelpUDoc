# A2UI Generic Input Loop Diagnosis and Mitigation Plan

Last updated: 2026-06-08

## Goal

Any HelpUDoc skill that needs user input during execution must pause through native A2UI, render an interactive surface, accept the user's answer, and resume the same skill from the paused point. This may happen multiple times in one run.

`frontend-slides` is the benchmark workflow because it naturally requires several gates:

1. Capture the user's presentation intent and constraints.
2. Generate and review an outline or layout.
3. Collect design/style feedback.
4. Generate the final artifact only after the required user decisions are complete.

The product goal is broader than `frontend-slides`: the same input-loop contract must work for research, data, document, spreadsheet, and future skills without hardcoding every flow to one skill.

## Desired Contract

When a skill needs user input, the agent should emit a structured workflow action:

```text
workflow_action(action="ask_user_a2ui", component="clarification.form", props_json=..., context_json=...)
```

or another native A2UI component such as:

```text
workflow_action(action="ask_user_a2ui", component="style.previewChooser", props_json=..., context_json=...)
```

The frontend should render the native A2UI request. The backend should persist the pending interrupt, accept the submitted answer, build a continuation prompt, and resume the skill without restarting from the beginning or repeating already answered gates.

## Observed Symptoms

### 1. Prose-only phantom UI

The model frequently claimed it had opened an A2UI prompt or form, but did not emit the structured workflow action. Examples seen in live runs:

```text
I have initiated the presentation setup form...
Please configure these options in the active UI component...
```

```text
I have successfully initiated the A2UI input gate as requested.
Please select your preferred output format...
```

From the user's perspective, this produced one of these states:

- The assistant says it is waiting for input, but no actual native form is available.
- The run shows "Waiting for approval" or "Awaiting your input" and appears stuck.
- After the user answers, the agent repeats the same gate instead of advancing.

### 2. Synthetic form rendered with wrong options

After adding the implicit guard, generic A2UI forms did render, but an early extraction bug picked up policy/tool bullets instead of the actual choices. A reproduced `research` smoke initially rendered options like:

```text
requireshitlplan: true
requiresworkspaceartifacts: true
mcpservers: (none declared)
requestplanapproval
```

instead of:

```text
Executive Summary
Full Report
Checklist
```

That meant A2UI rendering was present, but the generated form was semantically wrong.

### 3. Redis timeout noise

Recent agent logs include a Redis timeout from the RAG worker:

```text
agent-1  | ERROR:helpudoc_agent.rag_worker:RAG worker loop error; retrying soon
agent-1  | redis.exceptions.TimeoutError: Timeout reading from redis:6379
```

This is a real operational symptom, but current evidence does not identify it as the root cause of the A2UI input-loop failure. In the same log window, the live A2UI research smoke succeeded at the input-gate level, while backend logs showed normal Redis connectivity:

```text
backend-1 | Connected to Redis
backend-1 | Connected to Redis (blocking)
```

The Redis timeout should still be investigated separately because it can add noise, retries, or delayed background work.

## Current Findings

### Finding 1: The primary failure is model/tool contract drift

The model often describes the intended UI action in natural language instead of calling the workflow tool. That is not an A2UI renderer bug by itself. It is an agent-runtime contract problem: the model was trusted to call `workflow_action(action="ask_user_a2ui")`, but did not reliably do so.

Relevant files:

- `agent/config/runtime.yaml`
- `agent/helpudoc_agent/tools/workspace/builtins/a2ui.py`
- `agent/helpudoc_agent/tools/workspace/builtins/human_interrupts.py`
- `agent/helpudoc_agent/tools/workspace/factory.py`

### Finding 2: The implicit input guard is a compensation layer, not the ideal architecture

The guard detects when the assistant ended a skill turn with prose that implies it is waiting for user input. It then synthesizes a real A2UI clarification interrupt.

Relevant implementation:

- `agent/helpudoc_agent/implicit_input_detection.py`
- `agent/helpudoc_agent/middleware/implicit_input_guard.py`
- `agent/helpudoc_agent/interrupt_payloads.py`

Important current behavior:

- For `frontend-slides`, the guard can emit deterministic known gates such as presentation setup, outline confirmation, style path, mood/preset, and style preview.
- For generic non-slide skills, the guard emits a generic `clarification.form`.
- If choices are present in the assistant text or recent user prompt, the guard extracts them and places them into A2UI question options.
- Otherwise, the generic form allows freeform response.

This keeps runs from getting stuck, but it is still reactive. The preferred path is for the skill/model to emit A2UI directly.

### Finding 3: Native A2UI is now carried through the stream and frontend metadata

Interrupt chunks can now carry `a2uiRequest`, and the frontend preserves it in pending message metadata.

Relevant implementation:

- `packages/contracts/src/agentStream.ts`
- `packages/contracts/src/types.ts`
- `frontend/src/features/workspace/WorkspacePage.tsx`
- `frontend/src/components/chat/ChatMessageBubble.tsx`

Frontend behavior:

- If `pendingInterrupt.a2uiRequest` exists and native A2UI is enabled, `ChatMessageBubble` renders `A2UISurfaceRenderer`.
- Legacy `uiRequest` remains as compatibility projection, but should not be the source of truth long term.

### Finding 4: Synthetic A2UI resume requires a continuation prompt

Synthetic interrupts are not original LangGraph tool interrupts. The backend detects synthetic clarification interrupts and resumes by creating a continuation prompt instead of trying to resume the same checkpoint as if it were a native model interrupt.

Relevant implementation:

- `backend/src/services/agent-runs/lifecycle.ts`

Key behavior:

- `isSyntheticClarificationInterrupt` identifies implicit-guard interrupts.
- `buildSyntheticClarificationFollowupPrompt` tells the agent to continue from the paused point and not ask the same gate again.
- For generic skills, the follow-up prompt explicitly says: if another human decision is required, call `workflow_action(action="ask_user_a2ui")` and stop; otherwise complete the work.

### Finding 5: Research now works as a generic first-gate smoke

The live `research` smoke now reaches a native A2UI interrupt with correct options:

```json
{
  "component": "clarification.form",
  "skill": "research",
  "options": ["Executive Summary", "Full Report", "Checklist"],
  "status": "interrupted",
  "synthetic": true
}
```

This proves the generic guard can catch a prose-only input request, produce native A2UI, and preserve the intended options. It does not prove the entire generic multi-gate objective is complete for every skill.

## Evidence Snapshot

### Live agent log

Command:

```bash
docker compose --env-file env/local/stack.env -f infra/docker-compose.yml logs --tail=240 agent \
  | rg -i "a2ui|implicit|interrupt|redis|timeout|contract|error|exception|traceback|POST /agents"
```

Relevant output:

```text
agent-1 | INFO: 172.18.0.1:46190 - "POST /agents/fast/workspace/a2ui-generic-choice-live-check-4/chat/stream HTTP/1.1" 200 OK
agent-1 | A2UI input guard: missing required gate=None or prose implies a UI form without workflow_action/A2UI. skill=research
agent-1 | ERROR:helpudoc_agent.rag_worker:RAG worker loop error; retrying soon
agent-1 | redis.exceptions.TimeoutError: Timeout reading from redis:6379
```

Interpretation:

- The A2UI guard was invoked for `research`, which means the model still used prose instead of a proper `workflow_action`.
- The request returned HTTP 200 and emitted an interrupt.
- Redis timeout appears in the RAG worker, not in the A2UI stream handling path shown here.

### Backend Redis log

Command:

```bash
docker compose --env-file env/local/stack.env -f infra/docker-compose.yml logs --tail=240 backend \
  | rg -i "redis|timeout|contract|a2ui|implicit|error|exception|traceback"
```

Relevant output:

```text
backend-1 | Connected to Redis
backend-1 | Connected to Redis (blocking)
```

Interpretation:

- Backend Redis connectivity was healthy in the recent window.
- Current A2UI diagnosis should not attribute the primary input-loop failure to Redis without stronger evidence.

### Tests run during this investigation

Focused Python A2UI/interrupt tests:

```bash
python3 -m pytest tests/test_interrupt_payload_parsing.py \
  agent/tests/test_implicit_input_guard.py \
  agent/tests/test_workflow_action_tool.py -q
```

Observed result:

```text
54 passed
```

Backend lifecycle tests:

```bash
cd backend
RUN_A2UI_E2E=1 npm test -- --runTestsByPath \
  tests/agentRunService.test.ts \
  tests/detectImplicitInput.test.ts
```

Observed result:

```text
69 passed
```

Coverage this gives:

- A2UI payload normalization.
- Native request projection to legacy UI compatibility.
- Prose-only implicit input detection.
- Generic synthetic clarification recovery.
- Generic non-slide multi-gate resume in backend lifecycle tests.
- Frontend-slides deterministic gate progression in backend lifecycle tests.

Coverage this does not fully give:

- Browser-level click-through of every A2UI surface.
- Direct proof that every skill prompt/tooling reliably uses `workflow_action(action="ask_user_a2ui")`.
- Direct proof that all skills can complete after multiple user-input gates in live model runs.

## Mitigation Plan

### Phase 1: Stabilize the generic safety net

Status: partially implemented.

Actions:

1. Keep the implicit input guard enabled.
2. Expand detection only from reproduced phrases, with regression tests for each phrase.
3. Keep generic synthetic forms skill-neutral: `clarification.form` plus extracted choices and freeform text.
4. Avoid adding more frontend-slides-only branches unless they enforce the benchmark workflow.
5. Add telemetry for every synthetic guard activation:
   - skill id
   - detected signals
   - extracted choices
   - whether the interrupt was resumed
   - whether the resumed run completed or asked another gate

Success criteria:

- Prose-only input requests never leave the user with no UI.
- The synthetic form options match user-facing choices, not policy/tool text.
- Guard activations are visible enough to identify which skills still fail to call A2UI directly.

### Phase 2: Make direct A2UI the primary path

Status: not complete.

Actions:

1. Strengthen runtime instructions in `agent/config/runtime.yaml` so skills cannot describe A2UI in prose as a substitute for the tool call.
2. Make `workflow_action(action="ask_user_a2ui")` the documented primitive for all mid-run input.
3. Add skill authoring guidance: any skill that asks the user to choose, approve, confirm, review, provide preferences, or select an output mode must use A2UI.
4. Add agent-side validation: if an active skill emits prose like "I opened the form" without a tool call, count it as a contract violation metric.
5. Consider adding a retry path before synthetic fallback for generic skills:
   - first violation: loop model back with explicit tool-call correction
   - second violation: synthesize generic A2UI to protect user experience

Success criteria:

- Most input gates come from real `workflow_action` calls, not from guard synthesis.
- Synthetic guard usage decreases over time and becomes exceptional telemetry.

### Phase 3: Generalize gate state beyond frontend-slides

Status: partially implemented for frontend-slides; generic resume exists but generic gate state is shallow.

Actions:

1. Define a generic A2UI gate metadata model:
   - `skill`
   - `gateId`
   - `component`
   - `questionIds`
   - `required`
   - `completedAt`
   - `answers`
2. Persist completed gates by `skill + gateId`, not only frontend-slides gate ids.
3. Let skills declare expected gates optionally, but do not require every skill to predeclare a full workflow.
4. Support dynamic gates for open-ended skills like research:
   - output format
   - scope/depth
   - source preference
   - confirmation before artifact generation
5. Prevent repeated gates unless the user asks to revise or the skill explicitly invalidates a previous answer.

Success criteria:

- A generic skill can ask for input, resume, ask for a second unrelated input, resume again, and complete.
- The backend can explain which gates are complete for any skill.

### Phase 4: Improve frontend observability and UX

Status: partially implemented.

Actions:

1. Show native A2UI surfaces whenever `a2uiRequest` is present.
2. Keep legacy `uiRequest` only as a compatibility projection.
3. Add a small developer/debug affordance for A2UI surfaces:
   - component
   - skill
   - gate id
   - synthetic vs direct
4. Make synthetic forms visually acceptable but distinguishable in logs/metadata.
5. Ensure submitted answers are visible in the run event timeline for diagnosis.

Success criteria:

- A user can tell when the agent is actually waiting on a form.
- Developers can tell whether the form came from direct A2UI or implicit recovery.

### Phase 5: Address Redis worker timeout separately

Status: open.

Actions:

1. Inspect `agent/helpudoc_agent/rag_worker.py` and Redis stream blocking read configuration.
2. Determine whether the timeout is expected idle behavior, over-noisy logging, or a retry bug.
3. If expected, downgrade log level or handle timeout without traceback.
4. If unexpected, tune `xreadgroup` timeout, Redis client socket timeout, and worker retry behavior.
5. Confirm whether RAG worker retries can affect active agent response streams.

Success criteria:

- Redis timeout no longer obscures A2UI diagnosis.
- If Redis really affects a run, logs make that causal path explicit.

## Relevant Code Files

### Agent

- `agent/config/runtime.yaml`
  Runtime behavior and workflow-action guidance.

- `agent/helpudoc_agent/implicit_input_detection.py`
  Detects prose-only input requests and phantom UI claims.

- `agent/helpudoc_agent/middleware/implicit_input_guard.py`
  Synthesizes A2UI interrupts when the model fails to emit structured A2UI.

- `agent/helpudoc_agent/interrupt_payloads.py`
  Normalizes interrupt payloads and creates native `a2uiRequest` plus legacy `uiRequest`.

- `agent/helpudoc_agent/a2ui_workflows.py`
  Shared frontend-slides benchmark gate definitions.

- `agent/helpudoc_agent/tools/workspace/builtins/a2ui.py`
  Native A2UI workflow tool implementation.

- `agent/helpudoc_agent/tools/workspace/builtins/human_interrupts.py`
  Human interrupt compatibility tools.

### Backend

- `backend/src/services/agent-runs/lifecycle.ts`
  Run lifecycle, synthetic clarification resume, A2UI gate tracking, interrupt normalization.

- `backend/src/services/agent-runs/interrupts.ts`
  Interrupt persistence and normalization helpers.

- `backend/tests/agentRunService.test.ts`
  Backend run/resume tests, including frontend-slides and generic multi-gate behavior.

- `backend/tests/detectImplicitInput.test.ts`
  Backend-side implicit input detection tests.

### Frontend

- `frontend/src/features/workspace/WorkspacePage.tsx`
  Streams interrupt chunks into chat message metadata, including `a2uiRequest`.

- `frontend/src/components/chat/ChatMessageBubble.tsx`
  Chooses native `A2UISurfaceRenderer` when A2UI metadata is available.

- `frontend/src/a2ui/catalog.tsx`
  A2UI component catalog.

### Contracts

- `packages/contracts/src/types.ts`
  Shared A2UI and workflow action types.

- `packages/contracts/src/agentStream.ts`
  Stream chunk schema, including `a2uiRequest`.

### Existing Plans

- `docs/a2ui-native-migration-plan.md`
  Broader migration plan for native A2UI as the source of truth.

## Open Questions

1. Should generic skills get one retry to force a real `workflow_action(action="ask_user_a2ui")` before synthetic fallback, or should we always synthesize immediately to protect UX?
2. Should synthetic forms be visually marked as recovery-generated in dev mode?
3. What is the minimum gate metadata every skill must provide?
4. Should skill manifests declare possible user-input gates?
5. Should Redis worker timeout be treated as expected idle behavior or a separate reliability issue?

## Current Bottom Line

The system now has a functioning generic safety net: when the model asks for input in prose, the guard can synthesize a native A2UI clarification form and resume through backend lifecycle logic.

The target architecture is not finished. The durable fix is to make direct A2UI workflow actions the normal path for all skills, keep the implicit guard as telemetry-backed recovery, and generalize gate state so any skill can pause, receive user input, continue, pause again, and complete without frontend-slides-specific assumptions.
