# HITL Approval UX & Research Pre-Search Improvement Plan

## Problem Statement

Two issues with the current Human-in-the-Loop (HITL) approval flow:

1. **Feedback UX is broken** — The "Edit" button requires users to type valid JSON into a raw args textarea. Typing natural language (e.g., "do research on the latest info, not mid-2024") fails with **"Edited args must be valid JSON object."** There is no user-friendly way to provide feedback or instructions to the agent.

2. **Outdated research plans** — The research skill generates plans from the model's training data (knowledge cutoff ~mid-2024). The skill should run internet searches first to ground the plan in current information.

---

## 1. Frontend: HITL Approval Card Redesign

### Current UI (Broken)

The approval card currently renders:

```
┌─────────────────────────────────────────────────┐
│  APPROVAL REQUIRED                              │
│  Review and continue this run.                  │
│  ALLOWED: APPROVE  EDIT  REJECT                 │
│                                                 │
│  [Approve]  [Edit]  [Reject]                    │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │ {do research on the latest info, not    │    │
│  │  mid-2024}                              │    │
│  └─────────────────────────────────────────┘    │
│  placeholder: Edited args JSON for "Edit"       │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │                                         │    │
│  └─────────────────────────────────────────┘    │
│  placeholder: Reject message (optional)         │
└─────────────────────────────────────────────────┘
```

**Problems:**
- The first textarea expects raw JSON (`Record<string, unknown>`). Users type natural language → `JSON.parse` fails → error toast
- Two separate input fields are confusing — one for "Edit" args (JSON), one for "Reject" message (text)
- No visibility into **what** the agent is asking approval for (the plan/action details are hidden)

### Proposed UI

```
┌─────────────────────────────────────────────────┐
│  ⚡ APPROVAL REQUIRED                           │
│  Review and continue this run.                  │
│  ALLOWED: APPROVE  EDIT  REJECT                 │
│                                                 │
│  ┌─ Plan Details ──────────────────────────┐    │
│  │  plan_title: AI Agent Landscape 2024    │    │
│  │  plan_summary: This research will...    │    │
│  │  execution_checklist:                   │    │
│  │    - Search for recent developments     │    │
│  │    - Analyze market trends              │    │
│  │    ...                                  │    │
│  └─────────────────────────────────────────┘    │
│  (read-only, rendered from actionRequests args)  │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │                                         │    │
│  │                                         │    │
│  └─────────────────────────────────────────┘    │
│  placeholder: Your feedback or instructions     │
│               for the agent (optional)          │
│                                                 │
│  [Approve]  [Edit & Revise]  [Reject]           │
└─────────────────────────────────────────────────┘
```

**Key changes:**

| Aspect | Current | Proposed |
|--------|---------|----------|
| Input fields | 2 fields (JSON textarea + reject input) | 1 unified feedback textarea |
| Edit button label | "Edit" | "Edit & Revise" |
| JSON requirement | `JSON.parse()` required → error on plain text | Natural language accepted, sent as `message` |
| Plan visibility | Hidden — user has no idea what they're approving | Read-only preview of `actionRequests[0].args` rendered as formatted key-value pairs |
| Feedback routing | Edit → `editedAction.args` (JSON) | Edit → `message` (NL feedback to agent) |
| Reject message | Separate `<input>` field | Same unified textarea |

### Specific Code Changes

#### File: `frontend/src/pages/WorkspacePage.tsx`

**A. State variables (rename/merge):**
- Rename `approvalEditArgsByMessageId` → `approvalFeedbackByMessageId`
- Remove `approvalReasonByMessageId` — its role is absorbed by the unified field
- All references updated (search for both variable names)

**B. Approval card JSX (lines ~4795-4870):**

Replace the two-field layout with:

1. **Read-only plan preview** — New `<div>` that renders `pendingInterrupt.actionRequests[0].args` as formatted key-value pairs:
   ```tsx
   {(() => {
     const args = pendingInterrupt?.actionRequests?.[0]?.args;
     if (!args || !Object.keys(args).length) return null;
     return (
       <div className="mt-3 rounded-xl border border-slate-200/60 bg-slate-50/60 p-3 text-xs text-slate-600 max-h-48 overflow-y-auto">
         <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">Plan Details</p>
         {Object.entries(args).map(([key, value]) => (
           <div key={key} className="mb-1">
             <span className="font-semibold text-slate-500">{key}:</span>{' '}
             <span className="text-slate-700 whitespace-pre-wrap">
               {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
             </span>
           </div>
         ))}
       </div>
     );
   })()}
   ```

2. **Unified feedback textarea** — Replaces both old fields:
   ```tsx
   <textarea
     value={approvalFeedbackByMessageId[messageKey] || ''}
     onChange={(event) =>
       setApprovalFeedbackByMessageId((prev) => ({
         ...prev,
         [messageKey]: event.target.value,
       }))
     }
     className="w-full rounded-xl border border-slate-200/80 bg-white/80 p-2 text-xs text-slate-700 backdrop-blur-sm focus:border-sky-400 focus:outline-none"
     rows={3}
     placeholder="Your feedback or instructions for the agent (optional)"
   />
   ```

3. **Button labels** — Change "Edit" to "Edit & Revise"

**C. `handleInterruptDecision` handler (lines ~3063-3086):**

Replace the JSON-parse-or-throw block:

```diff
 if (decision === 'edit') {
-  const raw = approvalEditArgsByMessageId[messageKey] || '{}';
-  let parsedArgs: Record<string, unknown> = {};
-  try {
-    const parsed = JSON.parse(raw);
-    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
-      parsedArgs = parsed as Record<string, unknown>;
-    }
-  } catch {
-    throw new Error('Edited args must be valid JSON object.');
-  }
-  const firstAction = pendingInterrupt?.actionRequests?.[0];
-  options.editedAction = {
-    name: (firstAction?.name as string) || 'request_plan_approval',
-    args: parsedArgs,
-  };
+  const feedback = approvalFeedbackByMessageId[messageKey] || '';
+  const firstAction = pendingInterrupt?.actionRequests?.[0];
+  options.editedAction = {
+    name: (firstAction?.name as string) || 'request_plan_approval',
+    args: firstAction?.args || {},   // pass original args unchanged
+  };
+  options.message = feedback || 'User requested edits.';
 }
 if (decision === 'reject') {
-  options.message = approvalReasonByMessageId[messageKey] || 'Rejected by user';
+  options.message = approvalFeedbackByMessageId[messageKey] || 'Rejected by user';
 }
```

---

## 2. Backend: Pass NL Feedback Through on "edit"

### File: `backend/src/api/agent.ts`

**Decision endpoint (lines ~437-448):**

The `AgentDecision` type already supports `message?: string`. Currently, the "edit" branch doesn't pass `message`. Fix:

```diff
 payload.decision === 'edit'
   ? {
       type: 'edit' as const,
       edited_action: {
         name: payload.editedAction?.name || 'request_plan_approval',
         args: payload.editedAction?.args || {},
       },
+      message: payload.message,
     }
```

This ensures the agent's HITL framework receives the user's NL feedback alongside the edit decision, allowing it to understand what changes are requested.

---

## 3. Research Skill: Pre-Search Before Plan Generation

### File: `skills/research/SKILL.md`

Insert a new workflow step **before** the plan drafting step. Renumber subsequent steps.

```diff
 ## Workflow
 1. **Record the question**
    - Write the original user question to `/question.txt`.

+2. **Preliminary search (before planning)**
+   - The model's training data has a knowledge cutoff and may be outdated.
+     Before drafting any plan, run 2–3 `google_search` queries covering the
+     core topic and any known recent developments.
+   - Note today's date when evaluating source timeliness.
+   - Record key findings briefly in `/preliminary_search_notes.md`.
+   - Use these results to inform the scope, questions, and section outline
+     of the research plan.
+
-2. **Draft and share research plan (before any research)**
+3. **Draft and share research plan (informed by preliminary search)**
    - Create `/research_plan.md` including:
```

All subsequent step numbers increment by 1 (original steps 3–8 become 4–9).

---

## Verification

| # | Test | Expected Result |
|---|------|-----------------|
| 1 | Type plain English in the feedback field and click "Edit & Revise" | No JSON parse error; agent receives feedback and revises plan |
| 2 | Leave feedback empty and click "Approve" | Agent proceeds normally |
| 3 | Type a reason and click "Reject" | Agent stops; rejection message visible in conversation |
| 4 | Check approval card shows plan details | `plan_title`, `plan_summary`, `execution_checklist` visible in read-only preview |
| 5 | Start a research task | `google_search` calls appear in tool activity **before** `request_plan_approval` |
| 6 | Review generated research plan | Plan references current (2025-2026) information, not mid-2024 content |
