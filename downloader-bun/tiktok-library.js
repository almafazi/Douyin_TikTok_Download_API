import Tiktok from "@tobyg74/tiktok-api-dl";
import dotenv from 'dotenv';
import { encrypt, decrypt } from './encryption.js';
import { createClient } from 'redis';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3021';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'overflow';
const CACHE_TTL = parseInt(process.env.CACHE_TTL) || 3600;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Redis client setup
let redisClient;

async function initRedis() {
  try {
    redisClient = createClient({ url: REDIS_URL });
    
    redisClient.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });
    
    redisClient.on('connect', () => {
      console.log('[Redis] Connected successfully');
    });
    
    redisClient.on('disconnect', () => {
      console.log('[Redis] Disconnected');
    });
    
    await redisClient.connect();
    console.log('[Redis] Client initialized');
  } catch (error) {
    console.error('[Redis] Failed to initialize:', error.message);
    throw error;
  }
}

// Initialize Redis connection
initRedis();

/**
 * Normalize URL for cache key generation
 * @param {string} url - TikTok URL
 * @returns {string} - Normalized URL
 */
function normalizeUrl(url) {
  try {
    const urlObj = new URL(url);
    // Remove mobile and vm domains, use standard tiktok.com
    urlObj.hostname = urlObj.hostname.replace(/^(m\.|vm\.|www\.)?/, '');
    if (urlObj.hostname.includes('tiktok.com')) {
      urlObj.hostname = 'tiktok.com';
    }
    // Remove query parameters that don't affect content
    urlObj.search = '';
    urlObj.hash = '';
    return urlObj.toString();
  } catch (error) {
    // If URL parsing fails, return original URL
    return url;
  }
}

/**
 * Get cached result from Redis
 * @param {string} cacheKey - Cache key
 * @returns {Promise<Object|null>} - Cached result or null
 */
async function getCachedResult(cacheKey) {
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      const parsedData = JSON.parse(cached);
      console.log(`[Redis Cache] Hit for key: ${cacheKey.substring(0, 50)}...`);
      return parsedData;
    }
  } catch (error) {
    console.error('[Redis Cache] Error getting cached result:', error.message);
    throw error;
  }
  return null;
}

/**
 * Set cached result in Redis
 * @param {string} cacheKey - Cache key
 * @param {Object} data - Data to cache
 */
async function setCachedResult(cacheKey, data) {
  try {
    await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(data));
    console.log(`[Redis Cache] Set for key: ${cacheKey.substring(0, 50)}...`);
  } catch (error) {
    console.error('[Redis Cache] Error setting cached result:', error.message);
    throw error;
  }
}

/**
 * Format TikTok API response to match generateJsonResponse structure
 * @param {Object} apiResponse - Raw TikTok API response
 * @param {string} originalUrl - Original TikTok URL
 * @returns {Object} - Formatted response
 */
function formatTikTokResponse(apiResponse, originalUrl = '') {
  const data = apiResponse.resultNotParsed.content;
  const author = data.author;
  const statistics = data.statistics;
  const music = data.music;
  
  // Check if this is an image post
  const isImage = data.aweme_type === 150 && data.image_post_info;
  
  // Get music URL
  const musicUrl = music?.play_url?.uri || music?.play_url?.url_list?.[0] || '';
  
  const filteredAuthor = {
    nickname: author.nickname,
    signature: author.signature,
    avatar: author.avatar_thumb?.url_list?.[0] || ''
  };

  let picker = [];
  let metadata = {
    title: data.desc,
    description: data.desc,
    statistics: {
      repost_count: statistics.repost_count || 0,
      comment_count: statistics.comment_count,
      digg_count: statistics.digg_count,
      play_count: statistics.play_count
    },
    artist: author.nickname,
    cover: data.video?.cover?.url_list?.[0] || data.image_post_info?.image_post_cover?.display_image?.url_list?.[0],
    duration: data.video?.duration || 0,
    audio: musicUrl,
    download_link: {},
    music_duration: music?.duration,
    author: filteredAuthor
  };

  if (isImage) {
    // Handle image posts
    const images = data.image_post_info.images;
    
    picker = images.map(image => ({
      type: 'photo',
      url: image.display_image.url_list[0]
    }));

    // Create encrypted download links for images
    const encryptedNoWatermarkUrls = images.map(image => {
      const imageUrl = image.display_image.url_list[0];
      return encrypt(JSON.stringify({ 
        url: imageUrl, 
        author: author.nickname, 
        type: 'image' 
      }), ENCRYPTION_KEY, 360);
    });

    metadata.download_link.mp3 = `${BASE_URL}/download?data=${encrypt(JSON.stringify({
      url: musicUrl, 
      author: author.nickname, 
      type: 'mp3' 
    }), ENCRYPTION_KEY, 360)}`;

    metadata.download_link.no_watermark = encryptedNoWatermarkUrls.map(
      encryptedUrl => `${BASE_URL}/download?data=${encryptedUrl}`
    );
    
    metadata.download_slideshow_link = `${BASE_URL}/download-slideshow?url=${encrypt(originalUrl, ENCRYPTION_KEY, 360)}`;
    
  } else {
    // Handle video posts
    const video = data.video;
    
    const generateDownloadLink = (url, type) => {
      if (url) {
        const encryptedUrl = encrypt(JSON.stringify({
          url: url,
          author: author.nickname,
          type: type
        }), ENCRYPTION_KEY, 360);
        return `${BASE_URL}/download?data=${encryptedUrl}`;
      }
      return null;
    };

    // Extract video URLs
    const watermarkUrl = video.download_addr?.url_list?.[0];
    const noWatermarkHdUrl = video.play_addr_h264?.url_list?.[0] || video.play_addr?.url_list?.[0];
    const noWatermarkSdUrl = video.play_addr_bytevc1?.url_list?.[0];

    metadata.download_link = {
      watermark: generateDownloadLink(watermarkUrl, 'video'),
      no_watermark_hd: generateDownloadLink(noWatermarkHdUrl, 'video'),
      no_watermark: generateDownloadLink(noWatermarkSdUrl, 'video'),
      mp3: generateDownloadLink(musicUrl, 'mp3')
    };

    // Remove null download links
    Object.keys(metadata.download_link).forEach(key => {
      if (metadata.download_link[key] === null) {
        delete metadata.download_link[key];
      }
    });
  }

  return {
    status: isImage ? 'picker' : 'tunnel',
    photos: picker,
    ...metadata
  };
}

/**
 * Main function to generate TikTok response
 * @param {string} url - TikTok URL
 * @param {Object} options - Optional parameters
 * @returns {Promise<Object>} - Formatted TikTok response
 */
export async function generateTiktokResponse(url, options = {}) {
  try {
    const config = {
      version: options.version || "v1",
      cookie: options.cookie || null,
      showOriginalResponse: options.showOriginalResponse || false,
      ...options
    };

    // Generate cache key from normalized URL and config
    const cacheKey = `tiktok:${normalizeUrl(url)}:${JSON.stringify(config)}`;
    
    // Check cache first
    const cachedResult = await getCachedResult(cacheKey);
    if (cachedResult) {
      return formatTikTokResponse(cachedResult, url);
    }

    console.log(`[Cache] Miss for URL: ${url}`);
    const result = await Tiktok.Downloader(url, config);
    
    if (result.status !== 'success') {
      throw new Error(`TikTok API returned status: ${result.status}`);
    }

    // Cache the unencrypted result
    await setCachedResult(cacheKey, result);

    return formatTikTokResponse(result, url);
    
  } catch (error) {
    throw new Error(`Failed to process TikTok URL: ${error.message}`);
  }
}

/**
 * Get TikTok video/image information without download links
 * @param {string} url - TikTok URL
 * @param {Object} options - Optional parameters
 * @returns {Promise<Object>} - TikTok information
 */
export async function getTiktokInfo(url, options = {}) {
  try {
    const response = await generateTiktokResponse(url, options);
    
    // Remove download links for info-only response
    const { download_link, download_slideshow_link, ...info } = response;
    
    return info;
    
  } catch (error) {
    throw new Error(`Failed to get TikTok info: ${error.message}`);
  }
}

/**
 * Check if URL is a valid TikTok URL
 * @param {string} url - URL to validate
 * @returns {boolean} - Whether URL is valid TikTok URL
 */
export function isValidTikTokUrl(url) {
  return true;
}

/**
 * Get cache statistics
 * @returns {Promise<Object>} - Cache statistics
 */
export async function getCacheStats() {
  try {
    // Get Redis info
    const info = await redisClient.info('keyspace');
    const dbInfo = info.match(/db0:keys=(\d+)/);
    const totalKeys = dbInfo ? parseInt(dbInfo[1]) : 0;
    
    // Count tiktok-specific keys
    const tiktokKeys = await redisClient.keys('tiktok:*');
    
    return {
      cache_type: 'redis',
      total_entries: totalKeys,
      tiktok_entries: tiktokKeys.length,
      cache_ttl: CACHE_TTL,
      redis_url: REDIS_URL
    };
  } catch (error) {
    throw new Error(`Redis cache stats error: ${error.message}`);
  }
}

// Default export
export default {
  generateTiktokResponse,
  getTiktokInfo,
  isValidTikTokUrl,
  getCacheStats
};