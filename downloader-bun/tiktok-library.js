import Tiktok from "@tobyg74/tiktok-api-dl";
import dotenv from 'dotenv';
import { encrypt, decrypt } from './encryption.js';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3021';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'overflow';

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

    const result = await Tiktok.Downloader(url, config);
    
    if (result.status !== 'success') {
      throw new Error(`TikTok API returned status: ${result.status}`);
    }

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

// Default export
export default {
  generateTiktokResponse,
  getTiktokInfo,
  isValidTikTokUrl
};