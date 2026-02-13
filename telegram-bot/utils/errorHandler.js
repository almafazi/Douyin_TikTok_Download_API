import { createLogger } from './logger.js';

const logger = createLogger('ErrorHandler');

// Error types
export const ErrorTypes = {
  VALIDATION: 'VALIDATION_ERROR',
  RATE_LIMIT: 'RATE_LIMIT_ERROR',
  DOWNLOAD: 'DOWNLOAD_ERROR',
  API: 'API_ERROR',
  STREAM: 'STREAM_ERROR',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  NETWORK: 'NETWORK_ERROR',
  UNKNOWN: 'UNKNOWN_ERROR'
};

// Custom error class
export class BotError extends Error {
  constructor(type, message, details = {}) {
    super(message);
    this.type = type;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

// Error messages for users
const userErrorMessages = {
  [ErrorTypes.VALIDATION]: 'Invalid input. Please check your request and try again.',
  [ErrorTypes.RATE_LIMIT]: 'You are sending requests too quickly. Please wait a moment.',
  [ErrorTypes.DOWNLOAD]: 'Failed to download the file. The link may have expired.',
  [ErrorTypes.API]: 'The download service is temporarily unavailable. Please try again later.',
  [ErrorTypes.STREAM]: 'Error while transferring the file. Please try again.',
  [ErrorTypes.FILE_TOO_LARGE]: 'The file is too large to send via Telegram.',
  [ErrorTypes.NETWORK]: 'Network error. Please check your connection and try again.',
  [ErrorTypes.UNKNOWN]: 'An unexpected error occurred. Please try again later.'
};

/**
 * Handle error and return user-friendly message
 * @param {Error} error - Error object
 * @returns {Object}
 */
export function handleError(error) {
  // Log the error
  logger.error('Error occurred:', {
    type: error.type || ErrorTypes.UNKNOWN,
    message: error.message,
    stack: error.stack,
    details: error.details || {}
  });

  // Determine error type
  const errorType = error.type || classifyError(error);

  // Get user message
  const userMessage = userErrorMessages[errorType] || userErrorMessages[ErrorTypes.UNKNOWN];

  // Determine if error is retryable
  const retryable = [
    ErrorTypes.NETWORK,
    ErrorTypes.API,
    ErrorTypes.STREAM
  ].includes(errorType);

  return {
    type: errorType,
    userMessage,
    retryable,
    originalError: error.message
  };
}

/**
 * Classify error based on its properties
 * @param {Error} error - Error object
 * @returns {string}
 */
function classifyError(error) {
  if (error.code === 'FILE_TOO_LARGE' || error.message?.includes('too large')) {
    return ErrorTypes.FILE_TOO_LARGE;
  }

  if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
    return ErrorTypes.NETWORK;
  }

  if (error.response?.status === 429) {
    return ErrorTypes.RATE_LIMIT;
  }

  if (error.response?.status >= 500) {
    return ErrorTypes.API;
  }

  if (error.response?.status >= 400) {
    return ErrorTypes.VALIDATION;
  }

  if (error.message?.includes('stream')) {
    return ErrorTypes.STREAM;
  }

  return ErrorTypes.UNKNOWN;
}

/**
 * Async wrapper for handlers with error handling
 * @param {Function} fn - Async function to wrap
 * @param {Object} bot - Telegram bot instance
 * @returns {Function}
 */
export function withErrorHandler(fn, bot) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      const errorInfo = handleError(error);

      // Try to send error message to user
      try {
        const msg = args[0]; // First argument is usually the message
        if (msg?.chat?.id) {
          await bot.sendMessage(
            msg.chat.id,
            `❌ *Error*\n\n${errorInfo.userMessage}`,
            { parse_mode: 'Markdown' }
          );
        }
      } catch (sendError) {
        logger.error('Failed to send error message:', sendError.message);
      }

      // Re-throw for further handling if needed
      throw error;
    }
  };
}

/**
 * Safe async operation wrapper
 * @param {Promise} promise - Promise to wrap
 * @param {string} errorMessage - Error message on failure
 * @returns {Promise<[Error, null] | [null, any]>}
 */
export async function safeAsync(promise, errorMessage = 'Operation failed') {
  try {
    const result = await promise;
    return [null, result];
  } catch (error) {
    logger.error(errorMessage, error.message);
    return [error, null];
  }
}

/**
 * Safe message edit with error suppression
 * @param {Object} bot - Telegram bot instance
 * @param {string|number} chatId - Chat ID
 * @param {string|number} messageId - Message ID
 * @param {string} text - New text
 * @param {Object} options - Message options
 */
export async function safeEditMessage(bot, chatId, messageId, text, options = {}) {
  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...options
    });
  } catch (error) {
    // Ignore "message not modified" errors
    if (!error.message?.includes('message is not modified')) {
      logger.error('Failed to edit message:', error.message);
    }
  }
}

/**
 * Safe message deletion
 * @param {Object} bot - Telegram bot instance
 * @param {string|number} chatId - Chat ID
 * @param {string|number} messageId - Message ID
 */
export async function safeDeleteMessage(bot, chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (error) {
    logger.error('Failed to delete message:', error.message);
  }
}
