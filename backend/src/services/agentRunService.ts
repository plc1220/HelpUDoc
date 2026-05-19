/**
 * Compatibility barrel for agent run persistence and lifecycle.
 * Implementation lives under `./agent-runs/`.
 */
export type { AgentRunStatus } from './agent-runs/types';
export {
  isRealRunProgressEvent,
  shouldFailResumedRunForIdle,
} from './agent-runs/interrupts';
export { getRunStreamKey } from './agent-runs/persistence';
export {
  configureAgentRunServices,
  startAgentRun,
  persistInterruptAndStopRun,
  resumeAgentRun,
  resumeAgentRunWithResponse,
  resumeAgentRunWithAction,
  cancelAgentRun,
  getRunMeta,
  detectImplicitInputAwaiting,
} from './agent-runs/lifecycle';
