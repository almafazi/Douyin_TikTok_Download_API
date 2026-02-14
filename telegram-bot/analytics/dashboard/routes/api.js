import express from 'express';
import { analyticsService } from '../../services/analyticsService.js';

const router = express.Router();

// Get general stats
router.get('/stats', async (req, res) => {
  try {
    const { period = '24h' } = req.query;
    const stats = await analyticsService.getStats(period);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get downloads by type
router.get('/downloads/by-type', async (req, res) => {
  try {
    const { period = '24h' } = req.query;
    const data = await analyticsService.getDownloadsByType(period);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get commands stats
router.get('/commands', async (req, res) => {
  try {
    const { period = '24h' } = req.query;
    const data = await analyticsService.getCommandsStats(period);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get top users
router.get('/users/top', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const data = await analyticsService.getTopUsers(parseInt(limit));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get daily stats
router.get('/downloads/daily', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const data = await analyticsService.getDailyStats(parseInt(days));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get recent errors
router.get('/errors', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const data = await analyticsService.getRecentErrors(parseInt(limit));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export { router as analyticsRouter };
export default router;
