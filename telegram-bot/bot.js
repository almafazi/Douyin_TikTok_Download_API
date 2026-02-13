import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { createLogger } from './utils/logger.js';
import { formatDuration, formatNumber, truncateText } from './utils/helpers.js';
import { messages } from './utils/messages.js';
import { storeUrl, getUrl, closeRedis } from './utils/redis.js';
import { isRateLimited } from './utils/rateLimiter.js';
import { createAxiosInstance, streamDownload, getFilenameFromHeaders } from './utils/axiosConfig.js';
import { handleError, safeEditMessage, safeDeleteMessage, ErrorTypes, BotError } from './utils/errorHandler.js';
import { buildVideoKeyboard, buildSlideshowKeyboard } from './utils/keyboard.js';
import { createServer, startServer } from './server.js';

dotenv.config();

// Logger
const logger = createLogger('Bot');

// Config
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:6068';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024; // 50MB
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true';
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const SERVER_PORT = parseInt(process.env.SERVER_PORT, 10) || 3000;

if (!TOKEN) {
  logger.error('TELEGRAM_BOT_TOKEN is required!');
  process.exit(1);
}

// Initialize bot
let bot;
if (USE_WEBHOOK) {
  bot = new TelegramBot(TOKEN);
  logger.info('Bot initialized in webhook mode');
} else {
  bot = new TelegramBot(TOKEN, { polling: true });
  logger.info('Bot initialized in polling mode');
}

// API Client with retry
const apiClient = createAxiosInstance({
  baseURL: API_BASE_URL,
  timeout: 120000
});

// ============== MESSAGE HELPERS ==============

function sendMarkdownMessage(chatId, text, options = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...options
  });
}

// ============== RATE LIMIT MIDDLEWARE ==============

async function checkUserRateLimit(msg, type = 'command') {
  const userId = msg.from?.id;
  if (!userId) return { allowed: true };

  const rateLimit = await isRateLimited(userId, type);

  if (!rateLimit.allowed) {
    const resetInSeconds = Math.ceil(rateLimit.resetTime - (Date.now() / 1000));
    await sendMarkdownMessage(
      msg.chat.id,
      `⏳ *Rate limit exceeded!*\n\nPlease wait ${resetInSeconds} seconds before trying again.`
    );
    return { allowed: false };
  }

  return { allowed: true };
}

// ============== COMMAND HANDLERS ==============

// Start command
bot.onText(/\/start/, async (msg) => {
  if (!(await checkUserRateLimit(msg, 'command')).allowed) return;

  const chatId = msg.chat.id;
  const username = msg.from.username || msg.from.first_name;

  logger.info(`User ${username} (${chatId}) started the bot`);

  await bot.sendMessage(chatId, messages.welcome(username), {
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
});

// Help command
bot.onText(/\/help/, async (msg) => {
  if (!(await checkUserRateLimit(msg, 'command')).allowed) return;

  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, messages.help(), {
    parse_mode: 'Markdown'
  });
});

// Stats command
bot.onText(/\/stats/, async (msg) => {
  if (!(await checkUserRateLimit(msg, 'command')).allowed) return;

  const chatId = msg.chat.id;

  try {
    const response = await apiClient.get('/health');
    const health = response.data;

    await bot.sendMessage(chatId, messages.stats(health), {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('Health check failed:', error.message);
    await sendMarkdownMessage(chatId, messages.error('Failed to check TikTok downloader API status'));
  }
});

// ============== MESSAGE HANDLERS ==============

// Handle TikTok URLs
bot.on('message', async (msg) => {
  if (!(await checkUserRateLimit(msg, 'process')).allowed) return;

  const chatId = msg.chat.id;
  const text = msg.text;

  // Skip commands
  if (!text || text.startsWith('/')) return;

  // Check if it's a TikTok URL
  const tiktokRegex = /(https?:\/\/)?(www\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\/[^\s]+/i;
  const match = text.match(tiktokRegex);

  if (!match) {
    await sendMarkdownMessage(chatId, messages.invalidUrl());
    return;
  }

  const url = match[0];
  logger.info(`Processing TikTok URL from ${chatId}: ${url}`);

  // Send processing message
  const processingMsg = await sendMarkdownMessage(chatId, messages.processing());

  try {
    // Call API
    const response = await apiClient.post('/tiktok', { url });
    const data = response.data;

    logger.info(`API Response status: ${data.status}`);

    if (data.status === 'tunnel') {
      await safeEditMessage(bot, chatId, processingMsg.message_id, messages.readyToDownload());
      // Video content
      await handleVideoDownload(chatId, data, msg);
    } else if (data.status === 'picker') {
      await safeEditMessage(bot, chatId, processingMsg.message_id, messages.readyToDownload());
      // Image/Slideshow content
      await handleSlideshowDownload(chatId, data);
    } else {
      await safeEditMessage(bot, chatId, processingMsg.message_id, messages.error('Unsupported TikTok content format'));
    }

  } catch (error) {
    logger.error('Error processing URL:', error.message);

    const errorInfo = handleError(error);
    await safeEditMessage(
      bot,
      chatId,
      processingMsg.message_id,
      messages.error(errorInfo.userMessage),
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  }
});

// ============== CALLBACK QUERY HANDLERS ==============

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const userId = query.from.id;

  // Check rate limit for downloads
  const rateLimit = await isRateLimited(userId, 'download');
  if (!rateLimit.allowed) {
    const resetInSeconds = Math.ceil(rateLimit.resetTime - (Date.now() / 1000));
    await bot.answerCallbackQuery(query.id, {
      text: `Rate limit exceeded. Please wait ${resetInSeconds}s.`,
      show_alert: true
    });
    return;
  }

  try {
    await bot.answerCallbackQuery(query.id, { text: 'Processing your request...' });

    if (data.startsWith('dl:')) {
      const [, second, third] = data.split(':');
      const id = third || second;
      const url = await getUrl(id);

      if (url) {
        const type = third ? second : (/mp3|audio/i.test(url) ? 'mp3' : 'video');
        await handleDirectDownload(chatId, type, url, messageId);
      } else {
        await sendMarkdownMessage(chatId, messages.error('Link expired, please send URL again'));
      }
    } else if (data.startsWith('ss:')) {
      const [, id] = data.split(':');
      const url = await getUrl(id);

      if (url) {
        await handleSlideshowVideoDownload(chatId, url, messageId);
      } else {
        await sendMarkdownMessage(chatId, messages.error('Link expired, please send URL again'));
      }
    } else if (data.startsWith('photo:')) {
      const [, id] = data.split(':');
      const url = await getUrl(id);

      if (url) {
        await handlePhotoDownload(chatId, url, messageId);
      } else {
        await sendMarkdownMessage(chatId, messages.error('Link expired, please send URL again'));
      }
    } else if (data === 'cancel') {
      await safeDeleteMessage(bot, chatId, messageId);
      await bot.sendMessage(chatId, '❌ Canceled');
    }
  } catch (error) {
    logger.error('Callback query error:', error.message);
    const errorInfo = handleError(error);
    await sendMarkdownMessage(chatId, messages.error(errorInfo.userMessage));
  }
});

// ============== DOWNLOAD HANDLERS ==============

async function handleVideoDownload(chatId, data, originalMsg) {
  const { title, description, statistics, author, download_link, cover, duration } = data;

  // Build caption
  const caption = messages.videoInfo({
    author: author.nickname,
    title: truncateText(title || description, 100),
    duration: formatDuration(duration),
    views: formatNumber(statistics.play_count),
    likes: formatNumber(statistics.digg_count),
    comments: formatNumber(statistics.comment_count),
    shares: formatNumber(statistics.repost_count)
  });

  // Build inline keyboard with short IDs
  const keyboard = await buildVideoKeyboard(download_link);

  // Send info with cover
  await bot.sendPhoto(chatId, cover, {
    caption,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
}

async function handleSlideshowDownload(chatId, data) {
  const { title, description, statistics, author, photos, download_link, download_slideshow_link, cover } = data;

  // Build caption
  const caption = messages.slideshowInfo({
    author: author.nickname,
    title: truncateText(title || description, 100),
    photoCount: photos.length,
    views: formatNumber(statistics.play_count),
    likes: formatNumber(statistics.digg_count),
    comments: formatNumber(statistics.comment_count)
  });

  // Build inline keyboard with short IDs
  const keyboard = await buildSlideshowKeyboard(download_link, download_slideshow_link, photos);

  // Send info with cover
  await bot.sendPhoto(chatId, cover, {
    caption,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
}

async function handleDirectDownload(chatId, type, downloadUrl, messageId) {
  logger.info(`Direct download requested (streaming)`);

  if (!(await checkUserRateLimit({ from: { id: chatId }, chat: { id: chatId } }, 'download')).allowed) {
    return;
  }

  // Send downloading message
  const downloadingMsg = await sendMarkdownMessage(chatId, messages.downloading(type));

  try {
    // Stream download from API with streaming response
    const { stream, headers } = await streamDownload({
      method: 'GET',
      url: downloadUrl,
      timeout: 120000
    }, MAX_FILE_SIZE);

    // Get filename from headers
    const filename = getFilenameFromHeaders(headers['content-disposition'], 'download');

    // Update progress before sending file
    await safeEditMessage(bot, chatId, downloadingMsg.message_id, messages.uploading(type), {
      parse_mode: 'Markdown'
    });

    // Send file using stream - no buffer in memory!
    if (type === 'mp3') {
      await bot.sendAudio(chatId, stream, {
        title: filename,
        performer: 'TikTok Audio'
      });
    } else {
      await bot.sendVideo(chatId, stream, {
        caption: messages.downloadComplete(),
        supports_streaming: true
      });
    }

    await safeEditMessage(bot, chatId, downloadingMsg.message_id, messages.downloadComplete(), {
      parse_mode: 'Markdown'
    });

    logger.info(`Download completed: ${filename} (streamed)`);

  } catch (error) {
    logger.error('Download error:', error.message);

    if (error.code === 'FILE_TOO_LARGE') {
      await safeEditMessage(
        bot,
        chatId,
        downloadingMsg.message_id,
        messages.fileTooBig(formatNumber(error.contentLength), downloadUrl),
        { disable_web_page_preview: true }
      );
    } else {
      const errorInfo = handleError(error);
      await safeEditMessage(
        bot,
        chatId,
        downloadingMsg.message_id,
        messages.error(errorInfo.userMessage),
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    }
  }
}

async function handlePhotoDownload(chatId, photoUrl, messageId) {
  logger.info('Photo download requested');

  if (!(await checkUserRateLimit({ from: { id: chatId }, chat: { id: chatId } }, 'download')).allowed) {
    return;
  }

  try {
    // Send photo directly using URL
    await bot.sendPhoto(chatId, photoUrl, {
      caption: messages.downloadComplete()
    });

    logger.info('Photo sent successfully');
  } catch (error) {
    logger.error('Photo download error:', error.message);
    const errorInfo = handleError(error);
    await sendMarkdownMessage(chatId, messages.error(errorInfo.userMessage));
  }
}

async function handleSlideshowVideoDownload(chatId, encryptedUrl, messageId) {
  logger.info('Slideshow video download requested (background processing)');

  if (!(await checkUserRateLimit({ from: { id: chatId }, chat: { id: chatId } }, 'download')).allowed) {
    return;
  }

  // Send queued message - processing will happen in background
  const queuedMsg = await sendMarkdownMessage(chatId, messages.slideshowQueued());

  // Process in background (non-blocking)
  processSlideshowInBackground(chatId, encryptedUrl, queuedMsg.message_id);
}

async function processSlideshowInBackground(chatId, encryptedUrl, messageId) {
  try {
    // Build slideshow download URL
    // encryptedUrl bisa berupa full URL atau token saja
    const slideshowUrl = encryptedUrl.startsWith('http')
      ? encryptedUrl
      : `${API_BASE_URL}/download-slideshow?url=${encodeURIComponent(encryptedUrl)}`;

    // Download slideshow video with streaming
    // No timeout - let API handle the processing time
    logger.info(`Starting slideshow download from: ${slideshowUrl.substring(0, 100)}...`);
    const { stream } = await streamDownload({
      method: 'GET',
      url: slideshowUrl
      // No timeout specified - API handles retry and timeout internally
    }, MAX_FILE_SIZE);

    // Send video using stream - no buffer in memory!
    await bot.sendVideo(chatId, stream, {
      caption: messages.slideshowComplete(),
      supports_streaming: true
    });

    // Update the queued message to complete
    await safeEditMessage(bot, chatId, messageId, messages.slideshowComplete(), {
      parse_mode: 'Markdown'
    });

    logger.info('Slideshow video sent successfully (background)');

  } catch (error) {
    logger.error('Background slideshow error:', {
      message: error.message,
      code: error.code,
      response: error.response?.data,
      status: error.response?.status,
      stack: error.stack
    });

    // Fallback: provide manual download link if API fails
    if (error.response?.status >= 500 || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      const manualUrl = encryptedUrl.startsWith('http')
        ? encryptedUrl
        : `${API_BASE_URL}/download-slideshow?url=${encodeURIComponent(encryptedUrl)}`;
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `⚠️ *Slideshow creation failed*

The server is taking too long to process.

You can download manually using this link:
${manualUrl}

Or try again later.`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
      return;
    }

    if (error.code === 'FILE_TOO_LARGE') {
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        messages.fileTooBig(formatNumber(error.contentLength), encryptedUrl),
        { disable_web_page_preview: true }
      );
    } else {
      const errorInfo = handleError(error);
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        messages.error(errorInfo.userMessage),
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    }
  }
}

// ============== ERROR HANDLING ==============

bot.on('polling_error', (error) => {
  logger.error('Polling error:', error.message);
});

bot.on('error', (error) => {
  logger.error('Bot error:', error.message);
});

// ============== STARTUP ==============

async function startBot() {
  try {
    // Create Express server
    const app = createServer(bot);
    const server = await startServer(app, SERVER_PORT);

    // Setup webhook if enabled
    if (USE_WEBHOOK) {
      if (!WEBHOOK_URL) {
        logger.error('WEBHOOK_URL is required when USE_WEBHOOK is true');
        process.exit(1);
      }

      const webhookPath = `/webhook/${TOKEN}`;
      const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;

      await bot.setWebHook(fullWebhookUrl);
      logger.info(`Webhook set to: ${fullWebhookUrl}`);
    }

    logger.info('Bot is running...');

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`${signal} received. Shutting down gracefully...`);

      try {
        if (USE_WEBHOOK) {
          await bot.deleteWebHook();
          logger.info('Webhook deleted');
        } else {
          bot.stopPolling();
          logger.info('Polling stopped');
        }

        await closeRedis();
        server.close(() => {
          logger.info('Server closed');
          process.exit(0);
        });
      } catch (error) {
        logger.error('Error during shutdown:', error.message);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    logger.error('Failed to start bot:', error.message);
    process.exit(1);
  }
}

// Start the bot
startBot();
