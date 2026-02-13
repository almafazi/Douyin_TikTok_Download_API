import express from 'express';
import { createLogger } from './utils/logger.js';
import { checkRedisHealth } from './utils/redis.js';

const logger = createLogger('Server');

/**
 * Create Express server for health checks and webhooks
 * @param {Object} bot - Telegram bot instance
 * @returns {Object} Express app
 */
export function createServer(bot) {
  const app = express();

  // Middleware
  app.use(express.json());

  // Request logging
  app.use((req, res, next) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
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
