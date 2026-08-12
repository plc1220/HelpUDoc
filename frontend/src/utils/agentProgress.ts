import type { ConversationMessageMetadata } from '../types';
import type { AgentStreamChunk } from '@helpudoc/contracts/agentStream';

type ProgressEvent = NonNullable<ConversationMessageMetadata['progressEvents']>[number];

type AgentRunRefreshStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

const WAITING_FOR_INPUT_LABEL = /\b(?:awaiting|waiting)\b.*\b(?:your\s+)?input\b/i;

export const shouldRefreshWorkspaceFilesForRunStatus = (
  status: AgentRunRefreshStatus,
): boolean => (
  status === 'awaiting_approval'
  || status === 'completed'
  || status === 'failed'
  || status === 'cancelled'
);

export const shouldRefreshWorkspaceFilesForToolCompletion = (
  chunk: Extract<AgentStreamChunk, { type: 'tool_end' }>,
): boolean => chunk.outputFiles?.some((file) => Boolean(file.path?.trim())) === true;

export const markInteractionResponseReceived = (
  progressEvents: ConversationMessageMetadata['progressEvents'],
  timestamp = new Date().toISOString(),
): ProgressEvent[] => {
  const sourceEvents = progressEvents || [];
  const latestSource = sourceEvents[sourceEvents.length - 1];
  const hasActiveResponseMarker = latestSource?.label === 'Response received'
    && latestSource.status === 'running';
  const settledEvents = sourceEvents.map((event, index) => {
    if (WAITING_FOR_INPUT_LABEL.test(event.label || '')) {
      return { ...event, label: 'Input received', status: 'completed' as const };
    }
    if (hasActiveResponseMarker && index === sourceEvents.length - 1) {
      return event;
    }
    return event.status === 'running'
      ? { ...event, status: 'completed' as const }
      : event;
  });
  if (hasActiveResponseMarker) {
    return settledEvents;
  }
  return [
    ...settledEvents,
    {
      phase: 'routing',
      label: 'Response received',
      detail: 'Continuing with your decision.',
      status: 'running',
      timestamp,
    },
  ];
};
