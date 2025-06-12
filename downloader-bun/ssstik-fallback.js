import got from 'got';
import * as cheerio from 'cheerio';

class SsstikFallbackDownloader {
  constructor(options = {}) {
    this.baseUrl = 'https://ssstik.apigugel3.workers.dev';
    this.timeout = options.timeout || 30000;
    this.proxy = options.proxy || null;
    this.locale = options.locale || 'id';
    
    // Setup HTTP client with proxy if provided
    this.client = got.extend({
      timeout: {
        request: this.timeout
      },
      retry: {
        limit: 2
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      ...(this.proxy && {
        agent: null
      })
    });
  }

  async fetchTikTokData(url, minimal = true) {
    try {
      //console.log('🔄 Using SsstikFallback for:', url);
      
      // Step 1: Get the initial page to extract any required tokens
      const initialResponse = await this.client.get(this.baseUrl);
      
      // Step 2: Generate a random token (based on the pattern in your example)
      const tt = this.generateRandomToken();
      
      // Step 3: Prepare form data
      const formData = new URLSearchParams({
        'id': url,
        'locale': this.locale,
        'tt': tt
      });

      // Step 4: Make the POST request
      const response = await this.client.post(`${this.baseUrl}/abc?url=dl`, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': this.baseUrl,
          'Origin': this.baseUrl
        },
        body: formData.toString()
      });

      // Step 5: Parse the HTML response
      const parsedData = this.parseHtmlResponse(response.body);
      
      // Step 6: Convert to the expected format
      const convertedData = this.convertToStandardFormat(parsedData, url);
      
     // console.log('✅ SsstikFallback succeeded');
      return convertedData;
      
    } catch (error) {
      //console.error('❌ SsstikFallback failed:', error.message);
      throw new Error(`SsstikFallback failed: ${error.message}`);
    }
  }

  generateRandomToken() {
    // Generate a random token similar to the pattern in your example
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  // Helper function to decode tikcdn.io URLs
  decodeTikcdnUrl(url) {
    try {
      if (!url || !url.includes('tikcdn.io/ssstik/')) {
        return url; // Not a tikcdn URL or empty
      }
      
      // Handle different URL patterns: /a/, /p/, or direct
      let match = url.match(/tikcdn\.io\/ssstik\/a\/([^?]+)/);
      if (!match) {
        match = url.match(/tikcdn\.io\/ssstik\/p\/([^?]+)/);
      }
      if (!match) {
        match = url.match(/tikcdn\.io\/ssstik\/([^?]+)/);
      }
      
      if (match) {
        const encodedPart = match[1];
        
        // Check if it looks like base64 (contains base64 characters and proper length)
        const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
        
        // Only try to decode if it looks like base64 and is longer than a typical numeric ID
        if (base64Regex.test(encodedPart) && encodedPart.length > 20 && !(/^\d+$/.test(encodedPart))) {
          try {
            const decoded = Buffer.from(encodedPart, 'base64').toString('utf-8');
            
            // Verify the decoded content looks like a URL
            if (decoded.includes('http') || decoded.includes('tiktokcdn') || decoded.includes('douyin')) {
              return decoded;
            }
          } catch (decodeError) {
            // If base64 decode fails, return original URL
            console.warn('Base64 decode failed for:', encodedPart);
          }
        }
        
        // If it's not base64 or decode failed, return the original URL
        return url;
      }
      
      return url;
    } catch (error) {
      console.warn('Failed to process tikcdn URL:', url);
      return url;
    }
  }

  // Helper function to handle ssstik's numeric video IDs
  async handleNumericVideoId(numericId) {
    try {
      // Sometimes ssstik returns just a numeric ID that needs to be converted
      // Try to fetch the actual video URL using the numeric ID
      const videoUrl = `https://tikcdn.io/ssstik/${numericId}`;
      
      // Check if this redirects to actual video
      const response = await this.client.head(videoUrl, {
        followRedirect: false,
        timeout: { request: 5000 }
      });
      
      if (response.headers.location) {
        return response.headers.location;
      }
      
      return videoUrl; // Return as-is if no redirect
    } catch (error) {
      return `https://tikcdn.io/ssstik/${numericId}`; // Fallback
    }
  }
  extractUniqueImageUrls($, selector, seenUrls = new Set()) {
    const urls = [];
    
    $(selector).each((i, el) => {
      const imgSrc = $(el).attr('data-splide-lazy') || $(el).attr('src') || $(el).attr('href');
      if (!imgSrc) return;
      
      let finalUrl = imgSrc;
      
      // If it's a tikcdn.io URL, try to decode it
      if (imgSrc.includes('tikcdn.io/ssstik/')) {
        finalUrl = this.decodeTikcdnUrl(imgSrc);
      }
      
      // Only add if it's a valid TikTok CDN URL and we haven't seen it before
      if (finalUrl.includes('tiktokcdn') && !seenUrls.has(finalUrl)) {
        urls.push(finalUrl);
        seenUrls.add(finalUrl);
      }
    });
    
    return urls;
  }

  parseHtmlResponse(html) {
    const $ = cheerio.load(html);
    const result = {
      type: 'video', // default
      author: {},
      urls: {},
      metadata: {},
      isSlideshow: false
    };

    try {
      // Extract author information
      const authorImg = $('.result_author').attr('src') || '';
      const authorName = $('h2').first().text().trim() || '';
      const description = $('.maintext').text().trim() || '';

      result.author = {
        avatar: this.decodeTikcdnUrl(authorImg), // Decode avatar URL
        nickname: authorName,
        signature: description
      };

      result.metadata = {
        title: description,
        description: description
      };

      // Check if it's a slideshow (multiple images)
      const slidesData = $('input[name="slides_data"]').attr('value');
      const isSlideshow = !!slidesData || $('.splide').length > 0;

      if (isSlideshow) {
        result.type = 'image';
        result.isSlideshow = true;
        
        // Extract image URLs - prioritize direct URLs and avoid duplicates
        const seenUrls = new Set();
        let imageUrls = [];
        
        // Extract from slide images
        const slideImages = this.extractUniqueImageUrls($, '.splide__slide img', seenUrls);
        imageUrls.push(...slideImages);
        
        // Extract from download links
        const downloadImages = this.extractUniqueImageUrls($, '.download_link.slide', seenUrls);
        imageUrls.push(...downloadImages);

        // Try to extract from slides_data if we don't have enough images
        if (slidesData && imageUrls.length < 2) {
          try {
            const decoded = Buffer.from(slidesData, 'base64').toString('utf-8');
            const slidesInfo = JSON.parse(decoded);
            
            // Extract image URLs from slides data
            Object.keys(slidesInfo).forEach(key => {
              if (!isNaN(key) && slidesInfo[key].url) {
                const url = slidesInfo[key].url;
                if (url.includes('tiktokcdn') && !seenUrls.has(url)) {
                  imageUrls.push(url);
                  seenUrls.add(url);
                }
              }
            });
            
            // Also get music from slides data
            if (slidesInfo.music) {
              result.urls.audio = slidesInfo.music;
            }
          } catch (e) {
            console.warn('Failed to parse slides_data:', e.message);
          }
        }

        result.urls.images = imageUrls;

        // Extract music URL for slideshow if not already found
        if (!result.urls.audio) {
          const musicLink = $('.download_link.music').attr('href');
          if (musicLink) {
            result.urls.audio = this.decodeTikcdnUrl(musicLink);
          }
        }
      } else {
        // Regular video
        result.type = 'video';
        
        // Extract video download URLs
        const videoUrls = {};
        
        // Check for direct video links (without_watermark class)
        $('.download_link.without_watermark').each((i, el) => {
          const href = $(el).attr('href');
          const text = $(el).text().toLowerCase();
          
          if (href) {
            // Only decode if it looks like it needs decoding
            const processedUrl = this.decodeTikcdnUrl(href);
            
            if (text.includes('hd')) {
              videoUrls.no_watermark_hd = processedUrl;
            } else {
              videoUrls.no_watermark = processedUrl;
            }
          }
        });

        // Handle all download links that mention "tanpa tanda air" (without watermark)
        $('.download_link').each((i, el) => {
          const href = $(el).attr('href');
          const text = $(el).text().toLowerCase();
          
          if (href && text.includes('tanpa tanda air')) {
            const processedUrl = this.decodeTikcdnUrl(href);
            
            if (!videoUrls.no_watermark) {
              videoUrls.no_watermark = processedUrl;
            }
          }
        });

        // Look for HD download in onclick handlers
        $('[onclick*="downloadX"]').each((i, el) => {
          const onclick = $(el).attr('onclick');
          if (onclick) {
            // Extract the encoded URL from onclick="downloadX('/abc?url=...')"
            const match = onclick.match(/downloadX\('\/abc\?url=([^']+)'\)/);
            if (match) {
              try {
                // This is double-encoded, need to decode twice
                const firstDecode = Buffer.from(match[1], 'base64').toString('utf-8');
                // The result might be another encoded string, try to decode again
                if (firstDecode.includes('=')) {
                  const parts = firstDecode.split('=');
                  for (const part of parts) {
                    try {
                      const decoded = Buffer.from(part, 'base64').toString('utf-8');
                      if (decoded.includes('tiktokcdn') || decoded.includes('http')) {
                        videoUrls.no_watermark_hd = decoded;
                        break;
                      }
                    } catch (e) {
                      // Continue to next part
                    }
                  }
                }
              } catch (e) {
                console.warn('Failed to decode HD URL from onclick:', e.message);
              }
            }
          }
        });

        // Look for cover image in CSS style tags (not inline style)
        let coverUrl = null;
        
        // Parse <style> tags to find background-image
        $('style').each((i, styleEl) => {
          const cssContent = $(styleEl).html();
          if (cssContent && cssContent.includes('#mainpicture .result_overlay')) {
            // Look for background-image URL in the CSS
            const bgMatch = cssContent.match(/background-image:\s*url\(([^)]+)\)/);
            if (bgMatch && bgMatch[1]) {
              coverUrl = bgMatch[1].trim();
              // Remove quotes if present
              coverUrl = coverUrl.replace(/^['"]|['"]$/g, '');
            }
          }
        });
        
        // Also check inline style as fallback
        if (!coverUrl) {
          const bgStyle = $('#mainpicture .result_overlay').attr('style');
          if (bgStyle) {
            const bgMatch = bgStyle.match(/background-image:\s*url\(([^)]+)\)/);
            if (bgMatch && bgMatch[1]) {
              coverUrl = bgMatch[1].trim().replace(/^['"]|['"]$/g, '');
            }
          }
        }
        
        if (coverUrl) {
          // Decode the cover image URL
          result.metadata.cover = coverUrl;
        }

        // Extract audio URL
        const musicLink = $('.download_link.music').attr('href');
        if (musicLink) {
          result.urls.audio = this.decodeTikcdnUrl(musicLink);
        }

        result.urls.video = videoUrls;
      }

      // Extract engagement statistics
      const stats = {};
      $('#trending-actions .d-flex').each((i, el) => {
        const $el = $(el);
        const icon = $el.find('svg').attr('class') || '';
        const count = parseInt($el.find('div').last().text().trim()) || 0;
        
        if (icon.includes('thumbs-up')) {
          stats.digg_count = count;
        } else if (icon.includes('message-square')) {
          stats.comment_count = count;
        } else if (icon.includes('share')) {
          stats.repost_count = count;
        }
      });

      result.metadata.statistics = stats;

    } catch (error) {
      console.warn('Error parsing HTML response:', error.message);
    }

    return result;
  }

  convertToStandardFormat(parsedData, originalUrl) {
    // Convert to match the format expected by your main application
    const result = {
      code: 0,
      msg: "success",
      data: {
        aweme_id: this.extractAwemeId(originalUrl),
        type: parsedData.type,
        author: {
          nickname: parsedData.author.nickname || '',
          signature: parsedData.author.signature || '',
          avatar_thumb: {
            url_list: parsedData.author.avatar ? [parsedData.author.avatar] : []
          },
          uid: 'unknown'
        },
        desc: parsedData.metadata.description || '',
        statistics: {
          digg_count: parsedData.metadata.statistics?.digg_count || 0,
          comment_count: parsedData.metadata.statistics?.comment_count || 0,
          repost_count: parsedData.metadata.statistics?.repost_count || 0,
          play_count: 0
        },
        duration: 0
      }
    };

    if (parsedData.type === 'image') {
      // Image post (slideshow)
      result.data.image_data = {
        no_watermark_image_list: parsedData.urls.images || []
      };
      
      if (parsedData.urls.audio) {
        result.data.music = {
          play_url: {
            url_list: [parsedData.urls.audio],
            url: parsedData.urls.audio,
            uri: parsedData.urls.audio
          },
          duration: 15000 // Default duration for slideshow audio
        };
      }
    } else {
      // Video post
      result.data.video_data = {
        nwm_video_url: parsedData.urls.video?.no_watermark || '',
        nwm_video_url_HQ: parsedData.urls.video?.no_watermark_hd || '',
        wm_video_url: '', // Ssstik typically provides no-watermark versions
        wm_video_url_HQ: ''
      };

      if (parsedData.urls.audio) {
        result.data.music = {
          play_url: {
            url_list: [parsedData.urls.audio],
            url: parsedData.urls.audio,
            uri: parsedData.urls.audio
          }
        };
      }
    }

    // Add cover image if available
    if (parsedData.metadata.cover) {
      result.data.cover_data = {
        cover: {
          url_list: [parsedData.metadata.cover]
        }
      };
    }

    // Make sure avatar is properly set
    if (parsedData.author.avatar) {
      result.data.author.avatar_thumb = {
        url_list: [parsedData.author.avatar]
      };
    }

    return result;
  }

  extractAwemeId(url) {
    // Try to extract aweme ID from URL
    const patterns = [
      /\/video\/(\d+)/,
      /\/v\/([A-Za-z0-9]+)/,
      /aweme_id[=:](\d+)/,
      /item_id[=:](\d+)/
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return match[1];
      }
    }

    // Fallback: generate a hash based on URL
    return Math.abs(this.hashCode(url)).toString();
  }

  hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash;
  }

  // Health check method
  async healthCheck() {
    try {
      const response = await this.client.get(this.baseUrl, {
        timeout: { request: 5000 }
      });
      return response.statusCode === 200;
    } catch (error) {
      return false;
    }
  }
}

export default SsstikFallbackDownloader;