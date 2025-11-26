import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Shared Redis client for session storage and future caching needs.
export const redisClient = createClient({ url: redisUrl });

redisClient.on('error', (error) => {
  console.error('Redis connection error', error);
});

redisClient.on('connect', () => {
  console.log('Connected to Redis');
});
