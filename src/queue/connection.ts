import Redis from 'ioredis';
import { getEnv } from '../config/env';
import { logger } from '../utils/logger';

let redisInstance: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!redisInstance) {
    const env = getEnv();
    redisInstance = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy(times) {
        const delay = Math.min(times * 200, 2000);
        return delay;
      },
    });

    redisInstance.on('error', (err) => {
      logger.error({ err }, 'Redis connection error');
    });

    redisInstance.on('connect', () => {
      logger.info('Connected to Redis server');
    });
  }
  return redisInstance;
}
