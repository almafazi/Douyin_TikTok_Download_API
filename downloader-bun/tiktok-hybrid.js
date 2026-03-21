import got from 'got';
import dotenv from 'dotenv';
import { createClient } from 'redis';
import { encrypt } from './encryption.js';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3021';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'overflow';
const DOUYIN_API_URL = process.env.DOUYIN_API_URL || 'http://127.0.0.1:3035/api/hybrid/video_data';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '3600', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let redisClient;
let redisReady = false;

async function initRedis() {
  try {
    redisClient = createClient({ url: REDIS_URL });

    redisClient.on('error', (err) => {
      redisReady = false;
      console.error('[Redis] Connection error:', err.message);
    });

    redisClient.on('connect', () => {
      console.log('[Redis] Connected successfully');
    });

    redisClient.on('ready', () => {
      redisReady = true;
      console.log('[Redis] Client ready');
    });

    redisClient.on('disconnect', () => {
      redisReady = false;
      console.log('[Redis] Disconnected');
    });

    await redisClient.connect();
  } catch (error) {
    redisReady = false;
    console.error('[Redis] Failed to initialize:', error.message);
  }
}

initRedis();

function normalizeUrl(url) {
  try {
    const urlObj = new URL(url);
    urlObj.hostname = urlObj.hostname.replace(/^(m\.|vm\.|www\.)?/, '');
    if (urlObj.hostname.includes('tiktok.com')) {
      urlObj.hostname = 'tiktok.com';
    }
    urlObj.search = '';
    urlObj.hash = '';
    return urlObj.toString();
  } catch (error) {
    return url;
  }
}

async function getCachedResult(cacheKey) {
  if (!redisClient || !redisReady) {
    return null;
  }

  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      console.log(`[Redis Cache] Hit for key: ${cacheKey.substring(0, 50)}...`);
      return JSON.parse(cached);
    }
  } catch (error) {
    console.error('[Redis Cache] Error getting cached result:', error.message);
  }

  return null;
}

async function setCachedResult(cacheKey, data) {
  if (!redisClient || !redisReady) {
    return;
  }

  try {
    await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(data));
    console.log(`[Redis Cache] Set for key: ${cacheKey.substring(0, 50)}...`);
  } catch (error) {
    console.error('[Redis Cache] Error setting cached result:', error.message);
  }
}

function formatHybridResponse(apiResponse, originalUrl = '') {
  const videoData = apiResponse.data;
  const author = videoData.author || {};
  const statistics = videoData.statistics || {};
  const musicUrl = videoData.music?.play_url?.uri || videoData.music?.play_url?.url_list?.[0] || videoData.music?.play_url?.url || '';
  const isImage = videoData.type === 'image';

  const filteredAuthor = {
    nickname: author.nickname || '',
    signature: author.signature || '',
    avatar: author.avatar_thumb?.url_list?.[0] || ''
  };

  let picker = [];
  let metadata = {
    title: videoData.desc || filteredAuthor.nickname || '',
    description: videoData.desc || filteredAuthor.nickname || '',
    statistics: {
      repost_count: statistics.repost_count || 0,
      comment_count: statistics.comment_count || 0,
      digg_count: statistics.digg_count || 0,
      play_count: statistics.play_count || 0
    },
    artist: filteredAuthor.nickname,
    cover: videoData.cover_data?.cover?.url_list?.[0] || videoData.cover_data?.origin_cover?.url_list?.[0] || '',
    duration: videoData.duration || 0,
    audio: musicUrl,
    download_link: {},
    music_duration: videoData.music?.duration || 0,
    author: filteredAuthor
  };

  if (isImage) {
    const imageUrls = videoData.image_data;
    picker = imageUrls.no_watermark_image_list.map(url => ({
      type: 'photo',
      url: url
    }));

    const encryptedNoWatermarkUrls = imageUrls.no_watermark_image_list.map(url =>
      encrypt(JSON.stringify({ url, author: filteredAuthor.nickname || 'unknown', type: 'image' }), ENCRYPTION_KEY, 360)
    );

    metadata.download_link.mp3 = `${BASE_URL}/download?data=${encrypt(JSON.stringify({
      url: musicUrl,
      author: filteredAuthor.nickname || 'unknown',
      type: 'mp3'
    }), ENCRYPTION_KEY, 360)}`;

    metadata.download_link.no_watermark = encryptedNoWatermarkUrls.map(
      encryptedUrl => `${BASE_URL}/download?data=${encryptedUrl}`
    );

    metadata.download_slideshow_link = `${BASE_URL}/download-slideshow?url=${encrypt(originalUrl, ENCRYPTION_KEY, 360)}`;
  } else {
    const videoUrls = videoData.video_data || {};

    const generateDownloadLink = (url, type) => {
      if (!url) {
        return null;
      }
      const encryptedUrl = encrypt(JSON.stringify({
        url: url,
        author: filteredAuthor.nickname || 'unknown',
        type: type
      }), ENCRYPTION_KEY, 360);
      return `${BASE_URL}/download?data=${encryptedUrl}`;
    };

    metadata.download_link = {
      watermark: generateDownloadLink(videoUrls.wm_video_url, 'video'),
      watermark_hd: generateDownloadLink(videoUrls.wm_video_url_HQ, 'video'),
      no_watermark: generateDownloadLink(videoUrls.nwm_video_url, 'video'),
      no_watermark_hd: generateDownloadLink(videoUrls.nwm_video_url_HQ, 'video'),
      mp3: generateDownloadLink(musicUrl, 'mp3')
    };

    Object.keys(metadata.download_link).forEach((key) => {
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

async function fetchHybridApiData(url, minimal = true) {
  const apiURL = `${DOUYIN_API_URL}?url=${encodeURIComponent(url)}&minimal=${minimal ? 'true' : 'false'}`;
  const response = await got(apiURL, {
    timeout: { request: 20000 },
    retry: { limit: 1 },
    responseType: 'json'
  });
  return response.body;
}

export async function getHybridApiData(url, minimal = true) {
  const cacheKey = `hybrid:${normalizeUrl(url)}:minimal:${minimal ? '1' : '0'}`;
  const cached = await getCachedResult(cacheKey);
  if (cached && cached.data) {
    return cached;
  }

  const result = await fetchHybridApiData(url, minimal);
  if (!result || !result.data) {
    throw new Error('Hybrid API returned invalid payload');
  }

  await setCachedResult(cacheKey, result);
  return result;
}

export async function generateTiktokResponse(url, options = {}) {
  try {
    const minimal = options.minimal ?? true;
    const rawData = await getHybridApiData(url, minimal);
    return formatHybridResponse(rawData, url);
  } catch (error) {
    throw new Error(`Failed to process TikTok URL with hybrid API: ${error.message}`);
  }
}

export async function getTiktokInfo(url, options = {}) {
  const response = await generateTiktokResponse(url, options);
  const { download_link, download_slideshow_link, ...info } = response;
  return info;
}

export function isValidTikTokUrl(url) {
  return Boolean(url && (url.includes('tiktok.com') || url.includes('douyin.com')));
}

export function isRedisReady() {
  return redisReady;
}

export async function getCacheStats() {
  if (!redisClient || !redisReady) {
    return {
      cache_type: 'redis',
      total_entries: 0,
      hybrid_entries: 0,
      cache_ttl: CACHE_TTL,
      redis_url: REDIS_URL,
      status: 'offline'
    };
  }

  const info = await redisClient.info('keyspace');
  const dbInfo = info.match(/db0:keys=(\d+)/);
  const totalKeys = dbInfo ? parseInt(dbInfo[1], 10) : 0;
  const hybridKeys = await redisClient.keys('hybrid:*');

  return {
    cache_type: 'redis',
    total_entries: totalKeys,
    hybrid_entries: hybridKeys.length,
    cache_ttl: CACHE_TTL,
    redis_url: REDIS_URL,
    status: 'online'
  };
}

export default {
  generateTiktokResponse,
  getTiktokInfo,
  isValidTikTokUrl,
  getHybridApiData,
  isRedisReady,
  getCacheStats
};
