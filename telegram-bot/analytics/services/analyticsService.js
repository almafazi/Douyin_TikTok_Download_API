import { User } from '../models/User.js';
import { Download } from '../models/Download.js';
import { Command } from '../models/Command.js';
import { ErrorLog } from '../models/Error.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('Analytics');
const ANALYTICS_ENABLED = process.env.ANALYTICS_ENABLED !== 'false';

export class AnalyticsService {
  constructor() {
    this.enabled = ANALYTICS_ENABLED;
  }

  async trackUser(msg) {
    if (!this.enabled) return;
    
    try {
      const userId = msg.from?.id;
      if (!userId) return;

      await User.findOneAndUpdate(
        { userId },
        {
          $set: {
            username: msg.from?.username || null,
            firstName: msg.from?.first_name || null,
            lastName: msg.from?.last_name || null,
            languageCode: msg.from?.language_code || null,
            lastActive: new Date()
          },
          $setOnInsert: {
            firstSeen: new Date()
          }
        },
        { upsert: true, new: true }
      );
    } catch (error) {
      logger.error('Error tracking user:', error.message);
    }
  }

  async trackCommand(userId, command, responseTime = null) {
    if (!this.enabled) return;
    
    try {
      await Command.create({
        userId,
        command,
        responseTime,
        timestamp: new Date()
      });

      await User.findOneAndUpdate(
        { userId },
        { $inc: { totalCommands: 1 } }
      );
    } catch (error) {
      logger.error('Error tracking command:', error.message);
    }
  }

  async trackDownload(data) {
    if (!this.enabled) return;
    
    try {
      const {
        userId,
        url,
        contentType,
        quality = 'original',
        success,
        fileSize = null,
        duration = null,
        errorMessage = null,
        processingTime = null
      } = data;

      await Download.create({
        userId,
        url,
        contentType,
        quality,
        success,
        fileSize,
        duration,
        errorMessage,
        processingTime,
        timestamp: new Date()
      });

      if (success) {
        await User.findOneAndUpdate(
          { userId },
          { $inc: { totalDownloads: 1 } }
        );
      }
    } catch (error) {
      logger.error('Error tracking download:', error.message);
    }
  }

  async trackError(error, context = {}) {
    if (!this.enabled) return;
    
    try {
      await ErrorLog.create({
        userId: context.userId || null,
        errorType: error.name || 'UnknownError',
        message: error.message,
        stack: error.stack,
        context,
        timestamp: new Date()
      });
    } catch (err) {
      logger.error('Error tracking error:', err.message);
    }
  }

  async getStats(period = '24h') {
    try {
      const now = new Date();
      let startDate;

      switch (period) {
        case '24h':
          startDate = new Date(now - 24 * 60 * 60 * 1000);
          break;
        case '7d':
          startDate = new Date(now - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          startDate = new Date(now - 30 * 24 * 60 * 60 * 1000);
          break;
        default:
          startDate = new Date(now - 24 * 60 * 60 * 1000);
      }

      const [
        totalUsers,
        activeUsers,
        totalDownloads,
        successfulDownloads,
        totalCommands,
        recentErrors
      ] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ lastActive: { $gte: startDate } }),
        Download.countDocuments({ timestamp: { $gte: startDate } }),
        Download.countDocuments({ timestamp: { $gte: startDate }, success: true }),
        Command.countDocuments({ timestamp: { $gte: startDate } }),
        ErrorLog.countDocuments({ timestamp: { $gte: startDate } })
      ]);

      const successRate = totalDownloads > 0 
        ? Math.round((successfulDownloads / totalDownloads) * 100) 
        : 0;

      return {
        period,
        totalUsers,
        activeUsers,
        totalDownloads,
        successfulDownloads,
        failedDownloads: totalDownloads - successfulDownloads,
        successRate,
        totalCommands,
        recentErrors,
        generatedAt: new Date()
      };
    } catch (error) {
      logger.error('Error getting stats:', error.message);
      throw error;
    }
  }

  async getDownloadsByType(period = '24h') {
    try {
      const startDate = this.getStartDate(period);
      
      const results = await Download.aggregate([
        { $match: { timestamp: { $gte: startDate } } },
        { $group: { _id: '$contentType', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]);

      return results;
    } catch (error) {
      logger.error('Error getting downloads by type:', error.message);
      return [];
    }
  }

  async getCommandsStats(period = '24h') {
    try {
      const startDate = this.getStartDate(period);
      
      const results = await Command.aggregate([
        { $match: { timestamp: { $gte: startDate } } },
        { $group: { _id: '$command', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]);

      return results;
    } catch (error) {
      logger.error('Error getting commands stats:', error.message);
      return [];
    }
  }

  async getTopUsers(limit = 10) {
    try {
      const results = await User.find()
        .sort({ totalDownloads: -1 })
        .limit(limit)
        .select('userId username firstName totalDownloads totalCommands lastActive');

      return results;
    } catch (error) {
      logger.error('Error getting top users:', error.message);
      return [];
    }
  }

  async getDailyStats(days = 7) {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      startDate.setHours(0, 0, 0, 0);

      const results = await Download.aggregate([
        { $match: { timestamp: { $gte: startDate } } },
        {
          $group: {
            _id: {
              year: { $year: '$timestamp' },
              month: { $month: '$timestamp' },
              day: { $dayOfMonth: '$timestamp' }
            },
            downloads: { $sum: 1 },
            successful: { $sum: { $cond: ['$success', 1, 0] } },
            failed: { $sum: { $cond: ['$success', 0, 1] } }
          }
        },
        { $sort: { '_id.year': -1, '_id.month': -1, '_id.day': -1 } }
      ]);

      return results.map(r => ({
        date: `${r._id.year}-${String(r._id.month).padStart(2, '0')}-${String(r._id.day).padStart(2, '0')}`,
        downloads: r.downloads,
        successful: r.successful,
        failed: r.failed
      }));
    } catch (error) {
      logger.error('Error getting daily stats:', error.message);
      return [];
    }
  }

  async getRecentErrors(limit = 20) {
    try {
      const results = await ErrorLog.find()
        .sort({ timestamp: -1 })
        .limit(limit)
        .select('errorType message timestamp context');

      return results;
    } catch (error) {
      logger.error('Error getting recent errors:', error.message);
      return [];
    }
  }

  getStartDate(period) {
    const now = new Date();
    switch (period) {
      case '24h':
        return new Date(now - 24 * 60 * 60 * 1000);
      case '7d':
        return new Date(now - 7 * 24 * 60 * 60 * 1000);
      case '30d':
        return new Date(now - 30 * 24 * 60 * 60 * 1000);
      default:
        return new Date(now - 24 * 60 * 60 * 1000);
    }
  }
}

export const analyticsService = new AnalyticsService();
export default analyticsService;
