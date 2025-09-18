import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import dotenv from 'dotenv';

dotenv.config();

class TikTokFallbackDownloader {
    constructor(options = {}) {
        this.baseURL = options.baseURL || 'https://www.tikwm.com';
        this.apiEndpoint = '/api/';
        this.timeout = options.timeout || 30000;
        this.maxRetries = options.maxRetries || 2;
        this.retryDelay = options.retryDelay || 1000; // 1 second
        this.useProxy = process.env.USE_PROXY === 'true';

        // Setup axios instance with or without proxy
        const clientConfig = {
            baseURL: "https://www.tikwm.com",
            timeout: this.timeout,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Origin': 'https://www.tikwm.com',
                'Referer': 'https://www.tikwm.com/'
            }
        };

        if (this.useProxy) {
            clientConfig.httpsAgent = new HttpsProxyAgent(this.getRandomProxy());
        }

        this.client = axios.create(clientConfig);
    }

    /**
     * Get random proxy from the specified range
     * @returns {string} Random proxy URL
     */
    getRandomProxy() {
        const port = Math.floor(Math.random() * 3) + 60000; // Random port between 60000-60002

        // Check if running in Docker container
        const isDocker = process.env.DOCKER_ENV === 'true' ||
                        process.env.NODE_ENV === 'docker' ||
                        require('fs').existsSync('/.dockerenv');

        // Use host.docker.internal for Docker, 127.0.0.1 for local
        const proxyHost = isDocker ? 'host.docker.internal' : '127.0.0.1';

        return `http://${proxyHost}:${port}`;
    }

    /**
     * Sleep utility function for delays
     * @param {number} ms - Milliseconds to sleep
     * @returns {Promise}
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Check if error is a rate limit error
     * @param {Object} data - Response data
     * @returns {boolean}
     */
    isRateLimitError(data) {
        return data.code !== 0 && data.msg && data.msg.startsWith('Free Api Limit');
    }

    /**
     * Fetch TikTok data with retry logic
     * @param {string} url - TikTok video URL
     * @param {boolean} minimal - Minimal response (not used but kept for compatibility)
     * @returns {Promise<Object>} Video data in DOUYIN_API format
     */
    async fetchTikTokData(url, minimal = true) {
        let lastError;
        
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                const encodedUrl = encodeURIComponent(url);
                
                const formData = new URLSearchParams();
                formData.append('url', encodedUrl);
                formData.append('count', '12');
                formData.append('cursor', '0');
                formData.append('web', '1');
                formData.append('hd', '1');

                const response = await this.client.post(this.apiEndpoint, formData);
                
                if (response.data.code === 0) {
                    return this.convertToDouyinFormat(response.data);
                } else {
                    // Check if it's a rate limit error and we have retries left
                    if (this.isRateLimitError(response.data) && attempt < this.maxRetries) {
                        console.warn(`Rate limit hit on attempt ${attempt + 1}/${this.maxRetries + 1}. Retrying after ${this.retryDelay}ms...`);
                        await this.sleep(this.retryDelay);
                        lastError = new Error(response.data.msg || 'Rate limit exceeded');
                        continue;
                    } else {
                        throw new Error(response.data.msg || 'Failed to fetch video data');
                    }
                }
            } catch (error) {
                lastError = error;
                
                // If it's a network error or other non-API error, check if we should retry
                if (attempt < this.maxRetries && !error.response) {
                    console.warn(`Network error on attempt ${attempt + 1}/${this.maxRetries + 1}. Retrying after ${this.retryDelay}ms...`);
                    await this.sleep(this.retryDelay);
                    continue;
                }
                
                // If we've exhausted retries or it's not a retryable error, break
                break;
            }
        }
        
        console.error('TikTok Fallback Error:', lastError.message);
        throw new Error(`Fallback API failed after ${this.maxRetries + 1} attempts: ${lastError.message}`);
    }

    /**
     * Convert tikwm.com response to match your DOUYIN_API format
     * @param {Object} tikwmData - Response from tikwm.com
     * @returns {Object} Data in DOUYIN_API format
     */
    convertToDouyinFormat(tikwmData) {
        const data = tikwmData.data;
        
        // Determine if this is an image post (slideshow)
        const isImage = data.images && data.images.length > 0;
        
        // Convert author info
        const author = {
            nickname: data.author?.nickname || 'Unknown',
            signature: '', // Not available in tikwm
            uid: data.author?.id || '',
            avatar_thumb: {
                url_list: data.author?.avatar ? [`${this.baseURL}${data.author.avatar}`] : []
            }
        };

        // Convert statistics
        const statistics = {
            repost_count: data.share_count || 0,
            comment_count: data.comment_count || 0,
            digg_count: data.digg_count || 0,
            play_count: data.play_count || 0
        };

        // Convert music info
        const music = data.music_info ? {
            duration: data.music_info.duration || 0,
            play_url: {
                uri: data.music_info.play || '',
                url_list: data.music_info.play ? [data.music_info.play] : [],
                url: data.music_info.play || ''
            }
        } : null;

        let convertedData = {
            aweme_id: data.id,
            desc: data.title || '',
            author: author,
            statistics: statistics,
            music: music,
            duration: data.duration || 0,
            type: isImage ? 'image' : 'video',
            cover_data: {
                cover: {
                    url_list: data.cover ? [`${this.baseURL}${data.cover}`] : []
                }
            }
        };

        if (isImage) {
            // Handle slideshow/image posts
            convertedData.image_data = {
                no_watermark_image_list: data.images || []
            };
        } else {
            // Handle video posts
            convertedData.video_data = {
                nwm_video_url: data.play ? `${this.baseURL}${data.play}` : null,
                nwm_video_url_HQ: data.hdplay ? `${this.baseURL}${data.hdplay}` : null,
                wm_video_url: data.wmplay ? `${this.baseURL}${data.wmplay}` : null,
                wm_video_url_HQ: data.wmplay ? `${this.baseURL}${data.wmplay}` : null
            };
        }

        return {
            data: convertedData
        };
    }

    // /**
    //  * Set custom proxy
    //  * @param {string} proxyUrl - Proxy URL
    //  */
    // setProxy(proxyUrl) {
    //     this.proxy = proxyUrl;
    //     this.client.defaults.httpsAgent = new HttpsProxyAgent(proxyUrl);
    // }

    // /**
    //  * Disable proxy
    //  */
    // disableProxy() {
    //     this.proxy = null;
    //     this.client.defaults.httpsAgent = null;
    // }
}

export default TikTokFallbackDownloader;