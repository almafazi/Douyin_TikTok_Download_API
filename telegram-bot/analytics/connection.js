import mongoose from 'mongoose';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('MongoDB');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://root:changeme@localhost:27017/tiktok_bot?authSource=admin';

export async function connectMongoDB() {
  try {
    await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    
    logger.info('MongoDB connected successfully');
    
    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error:', err);
    });
    
    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
    });
    
    return mongoose.connection;
  } catch (error) {
    logger.error('Failed to connect to MongoDB:', error.message);
    throw error;
  }
}

export async function closeMongoDB() {
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
  } catch (error) {
    logger.error('Error closing MongoDB connection:', error.message);
  }
}

export default mongoose;
