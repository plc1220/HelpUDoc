import type { ConversationMessage } from '../types';

const timestamp = (value?: string): number | undefined => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Measure the whole response, including model work between tool calls. */
export const getAgentDurationBounds = (message: ConversationMessage, running: boolean, now: number) => {
  const progress = message.metadata?.progressEvents || [];
  const tools = message.toolEvents || [];
  const starts = [message.createdAt, ...progress.map(event => event.timestamp), ...tools.map(event => event.startedAt)]
    .map(timestamp).filter((value): value is number => value !== undefined);
  if (!starts.length) return undefined;
  const start = Math.min(...starts);
  const terminal = [...progress].reverse().find(event =>
    ['completed', 'failed', 'cancelled'].includes(event.phase) && timestamp(event.timestamp) !== undefined);
  const ends = [message.updatedAt, ...progress.map(event => event.timestamp), ...tools.map(event => event.finishedAt)]
    .map(timestamp).filter((value): value is number => value !== undefined);
  const end = running ? now : timestamp(terminal?.timestamp) ?? (ends.length ? Math.max(...ends) : undefined);
  if (end === undefined || end < start) return undefined;
  return { startedAt: new Date(start).toISOString(), finishedAt: new Date(end).toISOString() };
};
