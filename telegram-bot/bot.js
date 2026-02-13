import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import dotenv from 'dotenv';
import { createLogger } from './utils/logger.js';
import { formatDuration, formatNumber, truncateText } from './utils/helpers.js';
import { messages } from './utils/messages.js';

dotenv.config();

// 
const logger = createLogger('Bot');

// Config
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:6068';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024; // 50MB

if (!TOKEN) {
  logger.error('TELEGRAM_BOT_TOKEN is required!');
  process.exit(1);
}

// Initialize bot
const bot = new TelegramBot(TOKEN, { polling: true });
logger.info('Bot started successfully');

// Store download URLs (temporary storage)
const downloadUrls = new Map();
let urlIdCounter = 0;

// API Client
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 120000,
  headers: {
    'Content-Type': 'application/json'
  }
});

// ============== URL STORAGE ==============

function storeUrl(url) {
  const id = (++urlIdCounter).toString();
  downloadUrls.set(id, url);
  // Clean up after 1 hour
  setTimeout(() => downloadUrls.delete(id), 3600000);
  return id;
}

function getUrl(id) {
  return downloadUrls.get(id);
}

function sendMarkdownMessage(chatId, text, options = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...options
  });
}

async function safeEditMarkdownMessage(chatId, messageId, text, options = {}) {
  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...options
    });
  } catch (error) {
    if (!error.message?.includes('message is not modified')) {
      logger.error('Failed to edit markdown message:', error.message);
    }
  }
}

async function safeEditPlainMessage(chatId, messageId, text, options = {}) {
  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...options
    });
  } catch (error) {
    if (!error.message?.includes('message is not modified')) {
      logger.error('Failed to edit plain message:', error.message);
    }
  }
}

// ============== COMMAND HANDLERS ==============

// Start command
bot.onText(/\/start/, async (msg) => {
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
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, messages.help(), {
    parse_mode: 'Markdown'
  });
});

// Stats command
bot.onText(/\/stats/, async (msg) => {
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
      await safeEditMarkdownMessage(chatId, processingMsg.message_id, messages.readyToDownload());
      // Video content
      await handleVideoDownload(chatId, data, msg);
    } else if (data.status === 'picker') {
      await safeEditMarkdownMessage(chatId, processingMsg.message_id, messages.readyToDownload());
      // Image/Slideshow content
      await handleSlideshowDownload(chatId, data, url, msg);
    } else {
      await safeEditMarkdownMessage(chatId, processingMsg.message_id, messages.error('Unsupported TikTok content format'));
    }

  } catch (error) {
    logger.error('Error processing URL:', error.message);

    const errorMsg = error.response?.data?.error || error.message;
    await safeEditMarkdownMessage(chatId, processingMsg.message_id, messages.error(errorMsg));
  }
});

// ============== CALLBACK QUERY HANDLERS ==============

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  try {
    await bot.answerCallbackQuery(query.id, { text: 'Processing your request...' });

    if (data.startsWith('dl:')) {
      const [, second, third] = data.split(':');
      const id = third || second;
      const url = getUrl(id);
      if (url) {
        const type = third ? second : (/mp3|audio/i.test(url) ? 'mp3' : 'video');
        await handleDirectDownload(chatId, type, url, messageId);
      } else {
        await sendMarkdownMessage(chatId, messages.error('Link expired, please send URL again'));
      }
    } else if (data.startsWith('ss:')) {
      const [, id] = data.split(':');
      const url = getUrl(id);
      if (url) {
        await handleSlideshowVideoDownload(chatId, url, messageId);
      } else {
        await sendMarkdownMessage(chatId, messages.error('Link expired, please send URL again'));
      }
    } else if (data === 'cancel') {
      await bot.deleteMessage(chatId, messageId);
      await bot.sendMessage(chatId, '❌ Canceled');
    }
  } catch (error) {
    logger.error('Callback query error:', error.message);
    await sendMarkdownMessage(chatId, messages.error('An unexpected error occurred'));
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
  const keyboard = buildVideoKeyboard(download_link);

  // Send info with cover
  await bot.sendPhoto(chatId, cover, {
    caption,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
}

async function handleSlideshowDownload(chatId, data, originalUrl, originalMsg) {
  const { title, description, statistics, author, photos, download_link, cover } = data;

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
  const keyboard = buildSlideshowKeyboard(download_link, originalUrl);

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

  // Send downloading message
  const downloadingMsg = await sendMarkdownMessage(chatId, messages.downloading(type));

  try {
    // Stream download from API with streaming response
    const response = await axios({
      method: 'GET',
      url: downloadUrl,
      responseType: 'stream',
      timeout: 120000,
      maxContentLength: MAX_FILE_SIZE
    });

    // Check file size from headers
    const contentLength = parseInt(response.headers['content-length'], 10);
    if (contentLength && contentLength > MAX_FILE_SIZE) {
      await safeEditPlainMessage(
        chatId,
        downloadingMsg.message_id,
        messages.fileTooBig(formatNumber(contentLength), downloadUrl),
        { disable_web_page_preview: true }
      );
      response.data.destroy(); // Clean up stream
      return;
    }

    // Get filename from headers or generate
    const contentDisposition = response.headers['content-disposition'];
    let filename = 'download';
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/);
      if (match) filename = match[1];
    }

    // Update progress before sending file
    await safeEditMarkdownMessage(chatId, downloadingMsg.message_id, messages.uploading(type));

    // Send file using stream - no buffer in memory!
    if (type === 'mp3') {
      await bot.sendAudio(chatId, response.data, {
        title: filename,
        performer: 'TikTok Audio'
      });
    } else {
      await bot.sendVideo(chatId, response.data, {
        caption: messages.downloadComplete(),
        supports_streaming: true
      });
    }

    await safeEditMarkdownMessage(chatId, downloadingMsg.message_id, messages.downloadComplete());

    logger.info(`Download completed: ${filename} (streamed)`);

  } catch (error) {
    logger.error('Download error:', error.message);
    await safeEditMarkdownMessage(chatId, downloadingMsg.message_id, messages.error('Failed to download TikTok file'));
  }
}

async function handleSlideshowVideoDownload(chatId, encryptedUrl, messageId) {
  logger.info('Slideshow video download requested (streaming)');

  // Send processing message
  const processingMsg = await sendMarkdownMessage(chatId, messages.creatingSlideshow());

  try {
    // Build slideshow download URL
    const slideshowUrl = `${API_BASE_URL}/download-slideshow?url=${encodeURIComponent(encryptedUrl)}`;

    // Download slideshow video with streaming
    const response = await axios({
      method: 'GET',
      url: slideshowUrl,
      responseType: 'stream',
      timeout: 300000, // 5 minutes for slideshow creation
      maxContentLength: MAX_FILE_SIZE
    });

    // Check file size from headers
    const contentLength = parseInt(response.headers['content-length'], 10);
    if (contentLength && contentLength > MAX_FILE_SIZE) {
      await safeEditPlainMessage(
        chatId,
        processingMsg.message_id,
        messages.fileTooBig(formatNumber(contentLength), slideshowUrl),
        { disable_web_page_preview: true }
      );
      response.data.destroy(); // Clean up stream
      return;
    }

    await safeEditMarkdownMessage(chatId, processingMsg.message_id, messages.uploading('video'));

    // Send video using stream - no buffer in memory!
    await bot.sendVideo(chatId, response.data, {
      caption: messages.slideshowComplete(),
      supports_streaming: true
    });

    await safeEditMarkdownMessage(chatId, processingMsg.message_id, messages.slideshowComplete());

    logger.info('Slideshow video sent successfully (streamed)');

  } catch (error) {
    logger.error('Slideshow error:', error.message);
    await safeEditMarkdownMessage(chatId, processingMsg.message_id, messages.error('Failed to create TikTok slideshow video'));
  }
}

// ============== KEYBOARD BUILDERS ==============

function buildVideoKeyboard(downloadLinks) {
  const keyboard = [];

  // Video quality options
  if (downloadLinks.no_watermark_hd) {
    const id = storeUrl(downloadLinks.no_watermark_hd);
    keyboard.push([
      { text: '📹 HD (No Watermark)', callback_data: `dl:video:${id}` }
    ]);
  }

  if (downloadLinks.no_watermark) {
    const id = storeUrl(downloadLinks.no_watermark);
    keyboard.push([
      { text: '📹 SD (No Watermark)', callback_data: `dl:video:${id}` }
    ]);
  }

  if (downloadLinks.watermark) {
    const id = storeUrl(downloadLinks.watermark);
    keyboard.push([
      { text: '📹 With Watermark', callback_data: `dl:video:${id}` }
    ]);
  }

  // Audio option
  if (downloadLinks.mp3) {
    const id = storeUrl(downloadLinks.mp3);
    keyboard.push([
      { text: '🎵 Audio MP3', callback_data: `dl:mp3:${id}` }
    ]);
  }

  return keyboard;
}

function buildSlideshowKeyboard(downloadLinks, originalUrl) {
  const keyboard = [];

  // Slideshow video option
  if (downloadLinks.slideshow) {
    const id = storeUrl(originalUrl);
    keyboard.push([
      { text: '🎬 Download as Video', callback_data: `ss:${id}` }
    ]);
  }

  // Audio option
  if (downloadLinks.mp3) {
    const id = storeUrl(downloadLinks.mp3);
    keyboard.push([
      { text: '🎵 Audio MP3', callback_data: `dl:mp3:${id}` }
    ]);
  }

  return keyboard;
}

// ============== ERROR HANDLING ==============

bot.on('polling_error', (error) => {
  logger.error('Polling error:', error.message);
});

bot.on('error', (error) => {
  logger.error('Bot error:', error.message);
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Bot stopping...');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Bot stopping...');
  bot.stopPolling();
  process.exit(0);
});

logger.info('Bot is running...');
