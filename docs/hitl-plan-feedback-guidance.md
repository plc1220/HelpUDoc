# HITL guidance for plan-first skill orchestration

If your agent (for example, a research assistant or proposal helper) emits a **plan/context first** and then executes tools, the cleanest HITL pattern is a **two-stage run**:

1. **Planning stage**: Generate plan only (no side-effecting tools).
2. **Execution stage**: Execute tasks only after user approval or edits.

## Recommended flow

1. User asks for work.
2. Agent produces a draft plan.
3. Pause via interrupt and show plan to user.
4. User chooses one of:
   - Approve as-is
   - Edit plan
   - Reject/cancel
5. Resume with same thread/checkpoint state.
6. Agent executes tools using approved/edited plan.

This gives a predictable checkpoint where humans can shape intent before irreversible actions happen.

## Where to place HITL controls

Use two complementary guardrails:

- **Plan checkpoint interrupt** (workflow-level):
  - Add a pause immediately after plan generation.
  - Best for “review strategy before any action”.

- **Tool-level interrupts (`interrupt_on`)**:
  - Apply to sensitive tools like delete/write/send/publish.
  - Keep low-risk reads/list/search un-interrupted.
  - Configure decisions by risk:
    - High risk: approve + edit + reject
    - Medium risk: approve + reject
    - Low risk: no interrupt

## Critical implementation principles

- **Always use a checkpointer** so state survives pause/resume.
- **Reuse the same `thread_id`** when resuming.
- If multiple tool calls are interrupted together, provide decisions in the **same order** as action requests.
- If you allow argument edits, validate edited args before executing.

## Practical policy for your use case

For research/proposal orchestration, a practical default is:

- Planning step: always HITL (approve/edit/reject)
- Retrieval/read tools: no interrupt
- External side effects (email, file writes, ticket creation, publishing): interrupt required
- Destructive actions: full control (approve/edit/reject)

This keeps user collaboration high without slowing down harmless operations.

## UX guidance for end-user review

When you display the plan for review, include:

- Goal summary
- Assumptions
- Scope boundaries
- Data sources/tools to be used
- Expected outputs
- Risky actions requiring explicit approval

Ask users for structured feedback (not free-form only), for example:

- “Approve”
- “Edit step 2 to …”
- “Do not contact external systems”
- “Add competitor analysis section”

Structured feedback reduces ambiguity and makes resumption deterministic.

## Failure handling and safety

- If user rejects, end run gracefully with “no actions executed”.
- If edited plan conflicts with policy (forbidden tools, missing mandatory checks), request re-approval.
- Log approvals/edits/rejections for auditability.

## Suggested mental model

Think of your agent as:

- **Planner** (human-collaborative)
- **Executor** (policy-gated)

HITL should be strongest at the planner/executor boundary and on sensitive executor tools.
