import { redisClient } from '../redisService';
import type { PersistedRunMeta } from './types';

export const STREAM_TTL_SECONDS = 60 * 60 * 24; // 24h
export const DEBUG_AGENT_RUN_STREAM =
  process.env.DEBUG_AGENT_RUN_STREAM === '1' || process.env.DEBUG_AGENT_RUN_STREAM === 'true';

export const buildStreamKey = (runId: string) => `agent:run:${runId}`;
export const buildMetaKey = (runId: string) => `agent:run:${runId}:meta`;
export const buildRunDedupeKey = (workspaceId: string, persona: string, turnId: string) =>
  `agent:run:key:${workspaceId}:${persona}:${turnId}`;

export const getRunStreamKey = buildStreamKey;

export const persistMeta = async (runId: string, meta: Partial<PersistedRunMeta>) => {
  const metaKey = buildMetaKey(runId);
  const stringified: Record<string, string> = {};
  Object.entries(meta).forEach(([key, value]) => {
    if (value !== undefined) {
      stringified[key] = String(value);
    }
  });
  if (Object.keys(stringified).length) {
    await redisClient.hSet(metaKey, stringified);
    await redisClient.expire(metaKey, STREAM_TTL_SECONDS);
  }
};

export const appendStreamEvent = async (runId: string, line: string) => {
  if (!line.trim()) return;
  const streamKey = buildStreamKey(runId);
  try {
    const entryId = await redisClient.xAdd(streamKey, '*', { data: line });
    await redisClient.expire(streamKey, STREAM_TTL_SECONDS);
    if (DEBUG_AGENT_RUN_STREAM) {
      console.info('[agent-run-stream] appended', {
        runId,
        streamKey,
        entryId,
        bytes: line.length,
        sample: line.slice(0, 160),
      });
    }
  } catch (error) {
    console.error('[agent-run-stream] failed to append', { runId, streamKey, error });
    throw error;
  }
};
