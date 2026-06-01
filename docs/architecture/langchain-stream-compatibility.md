# LangChain Stream Compatibility

HelpUDoc is moving toward LangChain-compatible agent streams without replacing the existing workspace chat contract in one step.

## Direction

- Keep `AgentStreamChunk` as the stable HelpUDoc UI contract for the current workspace app.
- Project each chunk into LangChain-style roots:
  - `messages` for assistant text deltas
  - `toolCalls` for tool lifecycle events
  - `interrupts` for approval and clarification forms
  - `values` for terminal status and errors
  - `custom` for HelpUDoc-specific progress, policy, dashboard, and thought events
- Use the projection as the future integration point for `@langchain/react` experiments.

## Current Bridge

`@helpudoc/contracts/agentStream` exports:

- `normalizeAgentStreamChunk()`
- `toLangChainStreamProjection()`
- `streamAgentRunWithReconnect({ onLangChainProjection })`

The frontend can keep rendering the current HelpUDoc UI while a feature-flagged pane or adapter subscribes to `onLangChainProjection` to validate LangChain-compatible state handling.

## Migration Order

1. Normalize unsafe provider events before they reach chat rendering.
2. Maintain the existing HelpUDoc stream API.
3. Add projection tests and telemetry around `messages`, `toolCalls`, `interrupts`, and `custom`.
4. Pilot `@langchain/react` in an isolated pane using the projection.
5. Move the main chat renderer only after interrupts, artifacts, dashboards, and reconnect semantics are proven equivalent.
