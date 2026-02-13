import Redis from 'ioredis';
import { createLogger } from './logger.js';

const logger = createLogger('Redis');

// Redis configuration
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB, 10) || 0,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError: (err) => {
    const targetErrors = ['READONLY', 'ECONNREFUSED', 'ETIMEDOUT'];
    return targetErrors.some(e => err.message.includes(e));
  }
};

// Create Redis client
export const redis = new Redis(redisConfig);

// Redis event handlers
redis.on('connect', () => {
  logger.info('Redis connected');
});

redis.on('ready', () => {
  logger.info('Redis ready');
});

redis.on('error', (err) => {
  logger.error('Redis error:', err.message);
});

redis.on('reconnecting', () => {
  logger.warn('Redis reconnecting...');
});

redis.on('end', () => {
  logger.warn('Redis connection closed');
});

// URL Storage with TTL
const URL_PREFIX = 'url:';
const URL_TTL = 3600; // 1 hour

export async function storeUrl(url) {
  const id = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const key = `${URL_PREFIX}${id}`;

  try {
    await redis.setex(key, URL_TTL, url);
    return id;
  } catch (error) {
    logger.error('Failed to store URL:', error.message);
    throw error;
  }
}

export async function getUrl(id) {
  const key = `${URL_PREFIX}${id}`;

  try {
    const url = await redis.get(key);
    return url;
  } catch (error) {
    logger.error('Failed to get URL:', error.message);
    return null;
  }
}

export async function deleteUrl(id) {
  const key = `${URL_PREFIX}${id}`;

  try {
    await redis.del(key);
  } catch (error) {
    logger.error('Failed to delete URL:', error.message);
  }
}

// Rate Limiting
const RATE_LIMIT_PREFIX = 'ratelimit:';

export async function checkRateLimit(key, maxRequests, windowSeconds) {
  const fullKey = `${RATE_LIMIT_PREFIX}${key}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - windowSeconds;

  try {
    // Remove old entries
    await redis.zremrangebyscore(fullKey, 0, windowStart);

    // Count current entries
    const currentCount = await redis.zcard(fullKey);

    if (currentCount >= maxRequests) {
      const oldestTimestamp = await redis.zrange(fullKey, 0, 0, 'WITHSCORES');
      const resetTime = parseInt(oldestTimestamp[1], 10) + windowSeconds;
      return {
        allowed: false,
        remaining: 0,
        resetTime
      };
    }

    // Add new entry
    await redis.zadd(fullKey, now, `${now}_${Math.random()}`);
    await redis.expire(fullKey, windowSeconds);

    const remaining = maxRequests - currentCount - 1;

    return {
      allowed: true,
      remaining,
      resetTime: now + windowSeconds
    };
  } catch (error) {
    logger.error('Rate limit check failed:', error.message);
    // Allow request on error (fail open)
    return { allowed: true, remaining: 0, resetTime: now };
  }
}

// User session management
const SESSION_PREFIX = 'session:';
const SESSION_TTL = 86400; // 24 hours

export async function setUserSession(userId, data) {
  const key = `${SESSION_PREFIX}${userId}`;

  try {
    await redis.setex(key, SESSION_TTL, JSON.stringify(data));
  } catch (error) {
    logger.error('Failed to set user session:', error.message);
  }
}

export async function getUserSession(userId) {
  const key = `${SESSION_PREFIX}${userId}`;

  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    logger.error('Failed to get user session:', error.message);
    return null;
  }
}

// Health check
export async function checkRedisHealth() {
  try {
    await redis.ping();
    return { status: 'ok', connected: redis.status === 'ready' };
  } catch (error) {
    return { status: 'error', error: error.message, connected: false };
  }
}

// Graceful shutdown
export async function closeRedis() {
  logger.info('Closing Redis connection...');
  await redis.quit();
}
