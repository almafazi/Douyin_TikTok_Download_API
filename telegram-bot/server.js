import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { createLogger } from './utils/logger.js';
import { createAxiosInstance } from './utils/axiosConfig.js';
import {
  checkRedisHealth,
  createFlowSession,
  getFlowSession,
  updateFlowSession
} from './utils/redis.js';

const logger = createLogger('Server');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const monetagSdkPath = path.join(__dirname, 'node_modules', 'monetag-tg-sdk', 'index.js');
const miniAppDir = path.join(__dirname, 'miniapp');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:6068';
const API_TIMEOUT = parseInt(process.env.API_TIMEOUT, 10) || 120000;
const MONETAG_ZONE_ID = process.env.MONETAG_ZONE_ID || '10653178';

const tiktokRegex = /https?:\/\/(www\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\/[a-zA-Z0-9_\-\/@.?=&]+/;

function isTikTokUrl(url) {
  return typeof url === 'string' && tiktokRegex.test(url);
}

function buildPreview(data) {
  const safeStats = data?.statistics || {};
  const authorName = data?.author?.nickname || 'Unknown';
  const title = data?.title || data?.description || 'TikTok Content';

  return {
    status: data?.status,
    author: authorName,
    title,
    duration: data?.duration || 0,
    cover: data?.cover || null,
    stats: {
      views: safeStats.play_count || 0,
      likes: safeStats.digg_count || 0,
      comments: safeStats.comment_count || 0,
      shares: safeStats.repost_count || 0
    },
    photoCount: Array.isArray(data?.photos) ? data.photos.length : 0
  };
}

function buildDownloadOptions(payload) {
  const options = [];

  if (payload?.status === 'tunnel') {
    const links = payload?.download_link || {};

    if (links.no_watermark_hd) {
      options.push({ id: 'video_hd', label: 'Video HD (No Watermark)', kind: 'video' });
    }

    if (links.no_watermark) {
      options.push({ id: 'video_sd', label: 'Video SD (No Watermark)', kind: 'video' });
    }

    if (links.watermark) {
      options.push({ id: 'video_wm', label: 'Video With Watermark', kind: 'video' });
    }

    if (links.mp3) {
      options.push({ id: 'audio_mp3', label: 'Audio MP3', kind: 'audio' });
    }
  }

  if (payload?.status === 'picker') {
    if (payload?.download_slideshow_link) {
      options.push({ id: 'slideshow_video', label: 'Slideshow Video (MP4)', kind: 'slideshow' });
    }

    if (payload?.download_link?.mp3) {
      options.push({ id: 'audio_mp3', label: 'Audio MP3', kind: 'audio' });
    }

    if (Array.isArray(payload?.photos)) {
      payload.photos.forEach((_, index) => {
        options.push({ id: `photo_${index}`, label: `Photo ${index + 1}`, kind: 'photo' });
      });
    }
  }

  return options;
}

function resolveDownloadUrl(payload, optionId) {
  if (!payload || !optionId) return null;

  if (payload.status === 'tunnel') {
    const links = payload.download_link || {};

    if (optionId === 'video_hd') return links.no_watermark_hd || null;
    if (optionId === 'video_sd') return links.no_watermark || null;
    if (optionId === 'video_wm') return links.watermark || null;
    if (optionId === 'audio_mp3') return links.mp3 || null;
  }

  if (payload.status === 'picker') {
    if (optionId === 'slideshow_video') return payload.download_slideshow_link || null;
    if (optionId === 'audio_mp3') return payload.download_link?.mp3 || null;

    if (optionId.startsWith('photo_')) {
      const photoIndex = parseInt(optionId.replace('photo_', ''), 10);
      if (Number.isInteger(photoIndex) && photoIndex >= 0 && photoIndex < (payload.photos?.length || 0)) {
        return payload.photos[photoIndex]?.url || null;
      }
    }
  }

  return null;
}

function inferExtension(contentType, sourceUrl) {
  const normalizedType = (contentType || '').toLowerCase();
  if (normalizedType.includes('video/mp4')) return 'mp4';
  if (normalizedType.includes('audio/mpeg')) return 'mp3';
  if (normalizedType.includes('audio/mp4')) return 'm4a';
  if (normalizedType.includes('image/jpeg')) return 'jpg';
  if (normalizedType.includes('image/png')) return 'png';
  if (normalizedType.includes('image/webp')) return 'webp';

  try {
    const parsed = new URL(sourceUrl);
    const ext = path.extname(parsed.pathname || '').replace('.', '').toLowerCase();
    if (ext && ext.length <= 5) return ext;
  } catch {
    // Ignore parsing errors and fallback to binary
  }

  return 'bin';
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'file';
}

function buildAttachmentFilename(optionId, contentType, sourceUrl) {
  const ext = inferExtension(contentType, sourceUrl);
  const base = sanitizeFilenamePart(optionId);
  return `snaptik_${base}.${ext}`;
}

function setNoCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

/**
 * Create Express server for health checks, webhooks, and mini app
 * @param {Object} bot - Telegram bot instance
 * @param {Object} options - Additional dependencies
 * @returns {Object} Express app
 */
export function createServer(bot, options = {}) {
  const app = express();
  const apiClient = options.apiClient || createAxiosInstance({
    baseURL: API_BASE_URL,
    timeout: API_TIMEOUT
  });

  // Middleware
  app.use(express.json());

  // Request logging
  app.use((req, res, next) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
  });

  // Static mini app files (disable cache so Telegram/WebView picks updates immediately)
  app.use('/miniapp', (req, res, next) => {
    setNoCacheHeaders(res);
    next();
  });
  app.use('/miniapp', express.static(miniAppDir, {
    index: false,
    redirect: false,
    maxAge: 0
  }));
  app.get(['/miniapp', '/miniapp/'], (req, res) => {
    setNoCacheHeaders(res);
    res.sendFile(path.join(miniAppDir, 'index.html'));
  });

  // Health check endpoint
  app.get('/health', async (req, res) => {
    try {
      const redisHealth = await checkRedisHealth();
      const botInfo = bot.options?.webHook ? 'webhook' : 'polling';

      const health = {
        status: redisHealth.connected ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        services: {
          redis: redisHealth,
          bot: { mode: botInfo, status: 'running' }
        }
      };

      const statusCode = redisHealth.connected ? 200 : 503;
      res.status(statusCode).json(health);
    } catch (error) {
      logger.error('Health check failed:', error.message);
      res.status(503).json({
        status: 'error',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Readiness check (for Kubernetes)
  app.get('/ready', async (req, res) => {
    const redisHealth = await checkRedisHealth();

    if (redisHealth.connected) {
      res.status(200).json({ ready: true });
    } else {
      res.status(503).json({ ready: false, reason: 'Redis not connected' });
    }
  });

  // Liveness check (for Kubernetes)
  app.get('/live', (req, res) => {
    res.status(200).json({ alive: true });
  });

  // Metrics endpoint (basic)
  app.get('/metrics', (req, res) => {
    const metrics = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      timestamp: new Date().toISOString()
    };

    res.json(metrics);
  });

  // Expose Monetag npm SDK as browser module without bundler
  app.get('/vendor/monetag-tg-sdk.js', (req, res) => {
    res.type('js').sendFile(monetagSdkPath);
  });

  // Mini app: resolve session/preview (chat + mini app)
  app.get('/miniapp/api/session/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = await getFlowSession(sessionId);

    if (!session) {
      res.status(404).json({ error: 'Session not found or expired' });
      return;
    }

    res.json({
      sessionId,
      flow: session.flow,
      adWatched: Boolean(session.adWatched),
      preview: buildPreview(session.payload),
      createdAt: session.createdAt || null
    });
  });

  // Mini app: prepare TikTok data and create a gated session
  app.post('/miniapp/api/prepare', async (req, res) => {
    const rawUrl = req.body?.url;
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';

    if (!isTikTokUrl(url)) {
      res.status(400).json({ error: 'Invalid TikTok URL' });
      return;
    }

    try {
      const response = await apiClient.post('/tiktok', { url });
      const payload = response.data;

      if (!payload || (payload.status !== 'tunnel' && payload.status !== 'picker')) {
        res.status(400).json({ error: 'Unsupported TikTok content format' });
        return;
      }

      const sessionId = await createFlowSession({
        flow: 'miniapp',
        sourceUrl: url,
        payload,
        adWatched: false,
        createdAt: new Date().toISOString()
      });

      res.json({
        sessionId,
        adWatched: false,
        preview: buildPreview(payload)
      });
    } catch (error) {
      logger.error('Mini app prepare failed:', error.message);
      res.status(500).json({ error: 'Failed to process TikTok URL' });
    }
  });

  // Mini app: mark ad as watched (reward verified client-side by Monetag callback)
  app.post('/miniapp/api/reward', async (req, res) => {
    const sessionId = req.body?.sessionId;

    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const session = await getFlowSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found or expired' });
      return;
    }

    const updated = await updateFlowSession(sessionId, {
      adWatched: true,
      adWatchedAt: new Date().toISOString()
    });

    if (!updated) {
      res.status(500).json({ error: 'Failed to update session' });
      return;
    }

    // Chat flow helper: notify user that ad gate is completed
    if (updated.flow === 'chat' && updated.chatId) {
      const continueKeyboard = {
        inline_keyboard: [
          [{ text: '✅ Continue (after ad)', callback_data: `ad:continue:${sessionId}` }],
          [{ text: '❌ Cancel', callback_data: 'cancel' }]
        ]
      };

      const sendContinueFallbackMessage = () => bot.sendMessage(
        updated.chatId,
        '✅ Ad verified. Continue is now unlocked.',
        {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
          reply_markup: continueKeyboard
        }
      );

      if (updated.gateMessageId) {
        bot.editMessageReplyMarkup(continueKeyboard, {
          chat_id: updated.chatId,
          message_id: updated.gateMessageId
        }).catch(async (editError) => {
          logger.warn(`Failed to update ad gate keyboard: ${editError.message}`);
          try {
            await sendContinueFallbackMessage();
          } catch (notifyError) {
            logger.warn(`Failed to notify chat after reward: ${notifyError.message}`);
          }
        });
      } else {
        sendContinueFallbackMessage().catch((notifyError) => {
          logger.warn(`Failed to notify chat after reward: ${notifyError.message}`);
        });
      }
    }

    res.json({ ok: true, sessionId, adWatched: true });
  });

  // Mini app: get format options after ad has been watched
  app.get('/miniapp/api/options/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = await getFlowSession(sessionId);

    if (!session) {
      res.status(404).json({ error: 'Session not found or expired' });
      return;
    }

    if (!session.adWatched) {
      res.status(403).json({ error: 'Ad must be watched before showing options' });
      return;
    }

    const options = buildDownloadOptions(session.payload);

    res.json({
      sessionId,
      preview: buildPreview(session.payload),
      options
    });
  });

  // Mini app: resolve selected option to the download URL
  app.get('/miniapp/api/download/:sessionId/:optionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const optionId = req.params.optionId;
    const session = await getFlowSession(sessionId);

    if (!session) {
      res.status(404).json({ error: 'Session not found or expired' });
      return;
    }

    if (!session.adWatched) {
      res.status(403).json({ error: 'Ad must be watched before download' });
      return;
    }

    const targetUrl = resolveDownloadUrl(session.payload, optionId);

    if (!targetUrl) {
      res.status(404).json({ error: 'Download option not found' });
      return;
    }

    try {
      const upstream = await axios.get(targetUrl, {
        responseType: 'stream',
        timeout: API_TIMEOUT,
        maxRedirects: 5
      });

      const contentType = upstream.headers['content-type'] || 'application/octet-stream';
      const contentLength = upstream.headers['content-length'];
      const filename = buildAttachmentFilename(optionId, contentType, targetUrl);

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }

      upstream.data.on('error', (streamErr) => {
        logger.warn(`Download stream error: ${streamErr.message}`);
        if (!res.headersSent) {
          res.status(502).json({ error: 'Failed to stream download file' });
        } else {
          res.end();
        }
      });

      upstream.data.pipe(res);
    } catch (error) {
      logger.warn(`Mini app download proxy failed: ${error.message}`);
      res.status(502).json({ error: 'Failed to fetch download file' });
    }
  });

  // Public verification page for ad/network ownership checks
  app.get('/', (req, res) => {
    res.status(200).type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Telegram Bot Service</title>
  <script src='//libtl.com/sdk.js' data-zone='${MONETAG_ZONE_ID}' data-sdk='show_${MONETAG_ZONE_ID}'></script>
  <script type="module">
    import createAdHandler from '/vendor/monetag-tg-sdk.js';
    window.monetagAdHandler = createAdHandler('${MONETAG_ZONE_ID}');
  </script>
</head>
<body>
  <p>Service is running.</p>
  <p>Mini App: <a href="/miniapp">/miniapp</a></p>
</body>
</html>`);
  });

  // Webhook endpoint for Telegram
  const webhookPath = `/webhook/${process.env.TELEGRAM_BOT_TOKEN}`;
  app.post(webhookPath, (req, res) => {
    try {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    } catch (error) {
      logger.error('Webhook processing error:', error.message);
      res.sendStatus(500);
    }
  });

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use((err, req, res, next) => {
    logger.error('Express error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

/**
 * Start server
 * @param {Object} app - Express app
 * @param {number} port - Port number
 * @returns {Object} HTTP server
 */
export function startServer(app, port = 3000) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (err) => {
      if (err) {
        logger.error('Failed to start server:', err.message);
        reject(err);
      } else {
        logger.info(`Server listening on port ${port}`);
        resolve(server);
      }
    });
  });
}
