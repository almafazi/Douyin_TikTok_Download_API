import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

class TikTokFallbackDownloader {
    constructor(options = {}) {
        this.baseURL = options.baseURL || 'https://www.tikwm.com';
        this.apiEndpoint = '/api/';
        // this.proxy = options.proxy || 'http://ztgvzxrb-rotate:8tmkgjfb6k44@p.webshare.io:80/';
        this.timeout = options.timeout || 30000;
        
        // Setup axios instance with proxy
        this.client = axios.create({
            baseURL: "https://tiktok.apigugel3.workers.dev",
            timeout: this.timeout,
            // httpsAgent: new HttpsProxyAgent(this.proxy),
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Origin': 'https://www.tikwm.com',
                'Referer': 'https://www.tikwm.com/'
            }
        });
    }

    /**
     * Fetch TikTok data in the same format as your DOUYIN_API
     * @param {string} url - TikTok video URL
     * @param {boolean} minimal - Minimal response (not used but kept for compatibility)
     * @returns {Promise<Object>} Video data in DOUYIN_API format
     */
    async fetchTikTokData(url, minimal = true) {
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
                throw new Error(response.data.msg || 'Failed to fetch video data');
            }
        } catch (error) {
            console.error('TikTok Fallback Error:', error.message);
            throw new Error(`Fallback API failed: ${error.message}`);
        }
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