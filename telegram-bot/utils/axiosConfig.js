import axios from 'axios';
import axiosRetry from 'axios-retry';
import { createLogger } from './logger.js';

const logger = createLogger('Axios');

// Retry is disabled - API handles retry internally
const defaultRetryConfig = {
  retries: 0 // No retry on bot side
};

/**
 * Create an axios instance with retry configuration
 * @param {Object} config - Axios config
 * @param {Object} retryConfig - Retry config
 * @returns {Object} Axios instance
 */
export function createAxiosInstance(config = {}, retryConfig = {}) {
  const instance = axios.create({
    timeout: 120000,
    headers: {
      'Content-Type': 'application/json'
    },
    ...config
  });

  // Apply retry configuration
  axiosRetry(instance, {
    ...defaultRetryConfig,
    ...retryConfig
  });

  // Request interceptor
  instance.interceptors.request.use(
    (requestConfig) => {
      logger.debug(`${requestConfig.method?.toUpperCase()} ${requestConfig.url}`);
      return requestConfig;
    },
    (error) => {
      logger.error('Request error:', error.message);
      return Promise.reject(error);
    }
  );

  // Response interceptor
  instance.interceptors.response.use(
    (response) => {
      logger.debug(`Response: ${response.status} ${response.config.url}`);
      return response;
    },
    (error) => {
      if (error.response) {
        logger.error(`Response error: ${error.response.status} ${error.config?.url}: ${error.message}`);
      } else if (error.request) {
        logger.error('No response received:', error.message);
      } else {
        logger.error('Request setup error:', error.message);
      }
      return Promise.reject(error);
    }
  );

  return instance;
}

/**
 * Stream download with error handling
 * @param {Object} axiosConfig - Axios request config
 * @param {number} maxFileSize - Maximum file size in bytes
 * @returns {Promise<{stream: Object, headers: Object}>}
 */
export async function streamDownload(axiosConfig, maxFileSize) {
  const response = await axios({
    ...axiosConfig,
    responseType: 'stream'
  });

  const contentLength = parseInt(response.headers['content-length'], 10);

  if (contentLength && contentLength > maxFileSize) {
    response.data.destroy();
    const error = new Error(`File too large: ${contentLength} bytes`);
    error.code = 'FILE_TOO_LARGE';
    error.contentLength = contentLength;
    throw error;
  }

  // Handle stream errors
  response.data.on('error', (err) => {
    logger.error('Stream error:', err.message);
  });

  return {
    stream: response.data,
    headers: response.headers
  };
}

/**
 * Get filename from content-disposition header
 * @param {string} contentDisposition - Content-Disposition header value
 * @param {string} defaultName - Default filename
 * @returns {string}
 */
export function getFilenameFromHeaders(contentDisposition, defaultName = 'download') {
  if (!contentDisposition) return defaultName;

  const match = contentDisposition.match(/filename="?([^"]+)"?/);
  return match ? match[1] : defaultName;
}
