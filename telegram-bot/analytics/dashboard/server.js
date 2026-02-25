import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../../utils/logger.js';
import { analyticsRouter } from './routes/api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger('Dashboard');
const PORT = process.env.DASHBOARD_PORT || 3001;
const monetagSdkPath = path.join(__dirname, '..', '..', 'node_modules', 'monetag-tg-sdk', 'index.js');

export function createDashboardServer() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Static files
  app.use(express.static(path.join(__dirname, 'public')));

  // Expose Monetag npm SDK for browser module import
  app.get('/vendor/monetag-tg-sdk.js', (req, res) => {
    res.type('js').sendFile(monetagSdkPath);
  });

  // API routes
  app.use('/api', analyticsRouter);

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Serve dashboard
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  return app;
}

export async function startDashboardServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(PORT, () => {
      logger.info(`Analytics Dashboard running on port ${PORT}`);
      resolve(server);
    });
  });
}

export default { createDashboardServer, startDashboardServer };
