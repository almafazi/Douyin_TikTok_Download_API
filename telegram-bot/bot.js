import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import dotenv from 'dotenv';
import { createLogger } from './utils/logger.js';
import { formatDuration, formatNumber, truncateText } from './utils/helpers.js';
import { messages } from './utils/messages.js';

dotenv.config();

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
    await bot.sendMessage(chatId, messages.error('Gagal memeriksa status API'));
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
    await bot.sendMessage(chatId, messages.invalidUrl());
    return;
  }

  const url = match[0];
  logger.info(`Processing TikTok URL from ${chatId}: ${url}`);

  // Send processing message
  const processingMsg = await bot.sendMessage(chatId, messages.processing(), {
    parse_mode: 'Markdown'
  });

  try {
    // Call API
    const response = await apiClient.post('/tiktok', { url });
    const data = response.data;

    logger.info(`API Response status: ${data.status}`);

    // Delete processing message
    try { await bot.deleteMessage(chatId, processingMsg.message_id); } catch (e) {}

    if (data.status === 'tunnel') {
      // Video content
      await handleVideoDownload(chatId, data, msg);
    } else if (data.status === 'picker') {
      // Image/Slideshow content
      await handleSlideshowDownload(chatId, data, url, msg);
    } else {
      await bot.sendMessage(chatId, messages.error('Format tidak dikenali'));
    }

  } catch (error) {
    logger.error('Error processing URL:', error.message);

    // Safely delete processing message
    try { await bot.deleteMessage(chatId, processingMsg.message_id); } catch (e) {}

    const errorMsg = error.response?.data?.error || error.message;
    await bot.sendMessage(chatId, messages.error(errorMsg));
  }
});

// ============== CALLBACK QUERY HANDLERS ==============

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  try {
    await bot.answerCallbackQuery(query.id);

    if (data.startsWith('dl:')) {
      const [, id] = data.split(':');
      const url = getUrl(id);
      if (url) {
        await handleDirectDownload(chatId, id, url, messageId);
      } else {
        await bot.sendMessage(chatId, messages.error('Link expired, please send URL again'));
      }
    } else if (data.startsWith('ss:')) {
      const [, id] = data.split(':');
      const url = getUrl(id);
      if (url) {
        await handleSlideshowVideoDownload(chatId, url, messageId);
      } else {
        await bot.sendMessage(chatId, messages.error('Link expired, please send URL again'));
      }
    } else if (data === 'cancel') {
      await bot.deleteMessage(chatId, messageId);
      await bot.sendMessage(chatId, '❌ Dibatalkan');
    }
  } catch (error) {
    logger.error('Callback query error:', error.message);
    await bot.sendMessage(chatId, messages.error('Terjadi kesalahan'));
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
  logger.info(`Direct download requested`);

  // Send downloading message
  const downloadingMsg = await bot.sendMessage(chatId, messages.downloading(type));

  try {
    // Stream download from API
    const response = await axios({
      method: 'GET',
      url: downloadUrl,
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: MAX_FILE_SIZE
    });

    const buffer = Buffer.from(response.data);
    const fileSize = buffer.length;

    // Check file size (Telegram limit: 50MB for bots)
    if (fileSize > MAX_FILE_SIZE) {
      try { await bot.deleteMessage(chatId, downloadingMsg.message_id); } catch (e) {}
      await bot.sendMessage(
        chatId,
        messages.fileTooBig(formatNumber(fileSize))
      );
      return;
    }

    // Get filename from headers or generate
    const contentDisposition = response.headers['content-disposition'];
    let filename = 'download';
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/);
      if (match) filename = match[1];
    }

    // Send file based on type
    try { await bot.deleteMessage(chatId, downloadingMsg.message_id); } catch (e) {}

    if (type === 'mp3') {
      await bot.sendAudio(chatId, buffer, {
        title: filename,
        performer: 'TikTok Audio'
      });
    } else {
      await bot.sendVideo(chatId, buffer, {
        caption: messages.downloadComplete(),
        supports_streaming: true
      });
    }

    logger.info(`Download completed: ${filename} (${formatNumber(fileSize)} bytes)`);

  } catch (error) {
    logger.error('Download error:', error.message);
    try { await bot.deleteMessage(chatId, downloadingMsg.message_id); } catch (e) {}
    await bot.sendMessage(chatId, messages.error('Gagal mengunduh file'));
  }
}

async function handleSlideshowVideoDownload(chatId, encryptedUrl, messageId) {
  logger.info('Slideshow video download requested');

  // Send processing message
  const processingMsg = await bot.sendMessage(chatId, messages.creatingSlideshow());

  try {
    // Build slideshow download URL
    const slideshowUrl = `${API_BASE_URL}/download-slideshow?url=${encodeURIComponent(encryptedUrl)}`;

    // Download slideshow video
    const response = await axios({
      method: 'GET',
      url: slideshowUrl,
      responseType: 'arraybuffer',
      timeout: 300000, // 5 minutes for slideshow creation
      maxContentLength: MAX_FILE_SIZE
    });

    const buffer = Buffer.from(response.data);

    try { await bot.deleteMessage(chatId, processingMsg.message_id); } catch (e) {}
    await bot.sendVideo(chatId, buffer, {
      caption: messages.slideshowComplete(),
      supports_streaming: true
    });

    logger.info('Slideshow video sent successfully');

  } catch (error) {
    logger.error('Slideshow error:', error.message);
    try { await bot.deleteMessage(chatId, processingMsg.message_id); } catch (e) {}
    await bot.sendMessage(chatId, messages.error('Gagal membuat slideshow'));
  }
}

// ============== KEYBOARD BUILDERS ==============

function buildVideoKeyboard(downloadLinks) {
  const keyboard = [];

  // Video quality options
  if (downloadLinks.no_watermark_hd) {
    const id = storeUrl(downloadLinks.no_watermark_hd);
    keyboard.push([
      { text: '📹 HD (No Watermark)', callback_data: `dl:${id}` }
    ]);
  }

  if (downloadLinks.no_watermark) {
    const id = storeUrl(downloadLinks.no_watermark);
    keyboard.push([
      { text: '📹 SD (No Watermark)', callback_data: `dl:${id}` }
    ]);
  }

  if (downloadLinks.watermark) {
    const id = storeUrl(downloadLinks.watermark);
    keyboard.push([
      { text: '📹 With Watermark', callback_data: `dl:${id}` }
    ]);
  }

  // Audio option
  if (downloadLinks.mp3) {
    const id = storeUrl(downloadLinks.mp3);
    keyboard.push([
      { text: '🎵 Audio MP3', callback_data: `dl:${id}` }
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
      { text: '🎵 Audio MP3', callback_data: `dl:${id}` }
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
