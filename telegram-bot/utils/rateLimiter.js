import { checkRateLimit } from './redis.js';
import { createLogger } from './logger.js';

const logger = createLogger('RateLimiter');

// Rate limit configurations
const RATE_LIMITS = {
  // General command rate limit
  command: {
    maxRequests: parseInt(process.env.RATE_LIMIT_COMMAND_MAX, 10) || 30,
    windowSeconds: parseInt(process.env.RATE_LIMIT_COMMAND_WINDOW, 10) || 60
  },
  // Download rate limit (more strict)
  download: {
    maxRequests: parseInt(process.env.RATE_LIMIT_DOWNLOAD_MAX, 10) || 10,
    windowSeconds: parseInt(process.env.RATE_LIMIT_DOWNLOAD_WINDOW, 10) || 60
  },
  // TikTok URL processing
  process: {
    maxRequests: parseInt(process.env.RATE_LIMIT_PROCESS_MAX, 10) || 20,
    windowSeconds: parseInt(process.env.RATE_LIMIT_PROCESS_WINDOW, 10) || 60
  }
};

/**
 * Check if user is rate limited
 * @param {string} userId - Telegram user ID
 * @param {string} type - Rate limit type (command, download, process)
 * @returns {Promise<{allowed: boolean, remaining: number, resetTime: number}>}
 */
export async function isRateLimited(userId, type = 'command') {
  const config = RATE_LIMITS[type] || RATE_LIMITS.command;
  const key = `${type}:${userId}`;

  const result = await checkRateLimit(key, config.maxRequests, config.windowSeconds);

  if (!result.allowed) {
    logger.warn(`Rate limit exceeded for user ${userId} on ${type}`);
  }

  return result;
}

/**
 * Middleware wrapper for rate limiting
 * @param {Function} handler - Message handler function
 * @param {string} type - Rate limit type
 * @returns {Function}
 */
export function withRateLimit(handler, type = 'command') {
  return async (msg, ...args) => {
    const userId = msg.from?.id;

    if (!userId) {
      logger.warn('Rate limit check failed: no user ID');
      return handler(msg, ...args);
    }

    const rateLimit = await isRateLimited(userId, type);

    if (!rateLimit.allowed) {
      const resetInSeconds = Math.ceil(rateLimit.resetTime - (Date.now() / 1000));
      const bot = args[0]; // Bot instance passed as argument

      if (bot && bot.sendMessage) {
        await bot.sendMessage(
          msg.chat.id,
          `⏳ *Rate limit exceeded!*\n\nPlease wait ${resetInSeconds} seconds before trying again.`,
          { parse_mode: 'Markdown' }
        );
      }

      return;
    }

    return handler(msg, ...args);
  };
}

/**
 * Get rate limit info for user
 * @param {string} userId - Telegram user ID
 * @returns {Promise<Object>}
 */
export async function getRateLimitInfo(userId) {
  const info = {};

  for (const [type, config] of Object.entries(RATE_LIMITS)) {
    const key = `${type}:${userId}`;
    const result = await checkRateLimit(key, config.maxRequests, config.windowSeconds);
    info[type] = {
      ...result,
      maxRequests: config.maxRequests,
      windowSeconds: config.windowSeconds
    };
  }

  return info;
}
