import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Shared Redis client for session storage and future caching needs.
export type RedisClient = ReturnType<typeof createClient>;
export const redisClient: RedisClient = createClient({ url: redisUrl });
export const blockingRedisClient: RedisClient = redisClient.duplicate();

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
