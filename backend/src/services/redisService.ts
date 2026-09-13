import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Shared Redis client for session storage and future caching needs.
export type RedisClient = ReturnType<typeof createClient>;
export const redisClient: RedisClient = createClient({ url: redisUrl });
export const blockingRedisClient: RedisClient = redisClient.duplicate();

export const KNOWLEDGE_INGESTION_EVENTS_CHANNEL = 'knowledge:ingestion:events';
export const FILE_STATUS_EVENTS_CHANNEL = 'file:status:events';

redisClient.on('error', (error) => {
  console.error('Redis connection error', error);
});

redisClient.on('connect', () => {
  console.log('Connected to Redis');
});

blockingRedisClient.on('error', (error) => {
  console.error('Redis blocking connection error', error);
});

blockingRedisClient.on('connect', () => {
  console.log('Connected to Redis (blocking)');
});

/**
 * Redis is a notification layer for knowledge jobs, not their source of truth.
 * A Redis outage must not make a durable ingestion transition fail.
 */
export async function publishKnowledgeIngestionEvent(event: Record<string, unknown>): Promise<void> {
  if (!redisClient.isOpen) return;
  try {
    await redisClient.publish(KNOWLEDGE_INGESTION_EVENTS_CHANNEL, JSON.stringify(event));
  } catch (error) {
    console.error('Failed to publish knowledge ingestion event', error);
  }
}

/**
 * Tell other people looking at a workspace that a file's status moved.
 *
 * The same rule as knowledge events: the decision is already durable in `files`
 * and both audit trails by the time this runs, so a Redis outage costs a live
 * update, never the transition itself. Anyone who misses an event still sees the
 * change on their next listing.
 */
export async function publishFileStatusEvent(event: Record<string, unknown>): Promise<void> {
  if (!redisClient.isOpen) return;
  try {
    await redisClient.publish(FILE_STATUS_EVENTS_CHANNEL, JSON.stringify(event));
  } catch (error) {
    console.error('Failed to publish file status event', error);
  }
}
