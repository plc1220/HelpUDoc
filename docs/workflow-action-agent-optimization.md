# Workflow Action Agent Optimization

Status: Deferred

## Decision

Do not remove or rename the workflow-action surface in the current cleanup pass.
The frontend does not directly depend on the `workflow_action` tool name, but it
does depend on the interaction protocol emitted by the agent runtime:

- `pendingInterrupt` metadata;
- `interactionRequest` payloads;
- `WorkflowActionEvent` and `workflowActions` history;
- the `/respond`, `/decision`, and `/act` resume APIs;
- the `helpudoc.interaction` contract.

The backend and agent runtime are tightly coupled to the current tool name and
gate semantics. References exist in the workflow tool, skill registry, runtime
prompts, implicit-input guard, interaction-contract middleware, backend run
lifecycle, and a substantial test suite. Removing it directly would create
avoidable migration risk.

## Current execution model

```text
QuickJS eval
  -> pure computation and PTC orchestration
  -> no filesystem, network, or standard-library side effects

Inline Python Job
  -> bounded execution in Kubernetes
  -> private writable workspace snapshot transferred through object storage
  -> no application workspace PVC mount

Main-agent file tools
  -> canonical direct workspace authoring

Backend
  -> workspace lease
  -> filesystem-diff reconciliation
  -> artifact commit and stream metadata
```

QuickJS can orchestrate exposed `tools.*` calls, including loops and parallel
calls, but the side effects belong to the invoked host tools. PTC calls should
remain restricted because they currently do not inherit normal per-tool HITL
approval behavior.

## Deferred migration plan

1. Preserve the frontend interaction protocol unchanged.
2. Define one canonical backend interaction implementation.
3. Keep `workflow_action` as a compatibility adapter while callers migrate.
4. Update frontend-slides prompts, runtime guards, lifecycle guidance, and tests
   to use the canonical implementation.
5. Verify that frontend consumers still receive equivalent interrupt and action
   payloads.
6. Remove the old model-visible tool name only after repository and runtime
   references reach zero.

## Related cleanup

This work is separate from the lower-risk cleanup items:

- move `create_pdf_from_images` behind the PDF skill rather than global exposure;
- replace `export_bigquery_query` with the data skill materialization path;
- remove `arxiv_search` after confirming no active consumers;
- remove legacy `rag_query` while retaining the underlying knowledge retrieval
  service and `knowledge_search`/`knowledge_read` capabilities.

## Revisit criteria

Revisit this optimization when there is a migration test covering:

- frontend rendering of approval, clarification, and custom interaction forms;
- resume behavior through all three interaction endpoints;
- frontend-slides gate completion and loopback behavior;
- stream replay and `pendingInterrupt` persistence;
- compatibility handling for existing active runs.
