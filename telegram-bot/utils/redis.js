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
const FLOW_PREFIX = 'flow:';
const FLOW_TTL = 3600; // 1 hour

export async function storeUrl(url) {
  const id = Math.random().toString(36).substr(2, 8);
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

export async function createFlowSession(data, ttl = FLOW_TTL) {
  const id = Math.random().toString(36).slice(2, 12);
  const key = `${FLOW_PREFIX}${id}`;

  try {
    await redis.setex(key, ttl, JSON.stringify(data));
    return id;
  } catch (error) {
    logger.error('Failed to create flow session:', error.message);
    throw error;
  }
}

export async function getFlowSession(id) {
  const key = `${FLOW_PREFIX}${id}`;

  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    logger.error('Failed to get flow session:', error.message);
    return null;
  }
}

export async function updateFlowSession(id, patch, ttl = FLOW_TTL) {
  const current = await getFlowSession(id);
  if (!current) return null;

  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };

  const key = `${FLOW_PREFIX}${id}`;
  try {
    await redis.setex(key, ttl, JSON.stringify(next));
    return next;
  } catch (error) {
    logger.error('Failed to update flow session:', error.message);
    return null;
  }
}

export async function deleteFlowSession(id) {
  const key = `${FLOW_PREFIX}${id}`;
  try {
    await redis.del(key);
  } catch (error) {
    logger.error('Failed to delete flow session:', error.message);
  }
}

// Rate Limiting
const RATE_LIMIT_PREFIX = 'ratelimit:';

// Lua script for atomic rate limiting (sliding window)
const RATE_LIMIT_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_start = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local window_seconds = tonumber(ARGV[4])
local unique_id = ARGV[5]

redis.call('ZREMRANGEBYSCORE', key, 0, window_start)
local current_count = redis.call('ZCARD', key)

if current_count >= max_requests then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset_time = tonumber(oldest[2]) + window_seconds
  return {0, 0, reset_time}
end

redis.call('ZADD', key, now, unique_id)
redis.call('EXPIRE', key, window_seconds)

local remaining = max_requests - current_count - 1
return {1, remaining, now + window_seconds}
`;

export async function checkRateLimit(key, maxRequests, windowSeconds) {
  const fullKey = `${RATE_LIMIT_PREFIX}${key}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - windowSeconds;
  const uniqueId = `${now}_${Math.random().toString(36).substr(2, 6)}`;

  try {
    const result = await redis.eval(
      RATE_LIMIT_LUA,
      1,
      fullKey,
      now,
      windowStart,
      maxRequests,
      windowSeconds,
      uniqueId
    );

    return {
      allowed: result[0] === 1,
      remaining: result[1],
      resetTime: result[2]
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
