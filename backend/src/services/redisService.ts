import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Shared Redis client for session storage and future caching needs.
export type RedisClient = ReturnType<typeof createClient>;
export const redisClient: RedisClient = createClient({ url: redisUrl });
export const blockingRedisClient: RedisClient = redisClient.duplicate();

export const KNOWLEDGE_INGESTION_EVENTS_CHANNEL = 'knowledge:ingestion:events';

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
