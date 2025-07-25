import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { cleanupFolder, initCleanupSchedule } from './cleanup.js';
import dotenv from 'dotenv';
import { 
  encrypt, 
  decrypt,
} from './encryption.js';
import { createReadStream } from 'fs';
import got from 'got';
// Import the fallback library
import TikTokFallbackDownloader from './tiktok-fallback.js';
import SsstikFallbackDownloader from './ssstik-fallback.js';
import { Transform } from 'stream';
dotenv.config();
// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);
initCleanupSchedule('*/15 * * * *');

// Environment variables (normally in .env file)
const PORT = process.env.PORT || 3021;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3021';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'overflow';
const DOUYIN_API_URL = process.env.DOUYIN_API_URL || 'http://127.0.0.1:3035/api/hybrid/video_data';

// Initialize fallback downloader
const fallbackDownloader = new TikTokFallbackDownloader({
    proxy: null,
    timeout: 30000
});

import { generateTiktokResponse } from './tiktok-library.js';

// const fallbackDownloader = new SsstikFallbackDownloader({
//     proxy: null,
//     timeout: 30000
// });

// Initialize Express app
const app = express();

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Temp directory path
const tempDir = path.join(__dirname, 'temp');

// Create temp directory if it doesn't exist
fs.ensureDirSync(tempDir);

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Origin', 'Content-Type', 'Content-Length', 'Accept-Encoding', 'Authorization'],
  exposedHeaders: ['Content-Disposition', 'X-Filename', 'Content-Length']
}));
app.use(express.json());

// Content type mapping
const contentTypes = {
  mp3: ['audio/mpeg', 'mp3'],
  video: ['video/mp4', 'mp4'],
  image: ['image/jpeg', 'jpg']
};

async function downloadFile(url, outputPath) {
  try {
    const writeStream = fs.createWriteStream(outputPath);
    
    await new Promise((resolve, reject) => {
      const downloadStream = got.stream(url, {
        timeout: {
          request: 120000 // 120 seconds timeout
        },
        retry: {
          limit: 2
        }
      });
      
      downloadStream.pipe(writeStream);
      
      downloadStream.on('error', (error) => {
        reject(error);
      });
      
      writeStream.on('finish', () => {
        resolve();
      });
      
      writeStream.on('error', (error) => {
        reject(error);
      });
    });
    
    return outputPath;
  } catch (error) {
    throw new Error(`Failed to download file: ${error.message}`);
  }
}

// Create a slideshow from images and audio
function createSlideshow(imagePaths, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg();
    
    // Add each image as input
    imagePaths.forEach(imagePath => {
      command.input(imagePath).inputOptions(['-loop 1', '-t 4']);
    });
    
    // Add audio with loop
    command.input(audioPath).inputOptions(['-stream_loop -1']);
    
    // Build complex filter for scaling and concatenating images
    const filter = [];
    
    // Scale and pad each image
    imagePaths.forEach((_, index) => {
      filter.push(`[${index}:v]scale=w=1080:h=1920:force_original_aspect_ratio=decrease,` +
        `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${index}]`);
    });
    
    // Concatenate all scaled/padded video streams
    const concatInputs = imagePaths.map((_, i) => `[v${i}]`).join('');
    filter.push(`${concatInputs}concat=n=${imagePaths.length}:v=1:a=0[vout]`);
    
    // Calculate total duration
    const videoDuration = imagePaths.length * 4;
    
    // Add audio filter to trim the looping audio to the video duration
    filter.push(`[${imagePaths.length}:a]atrim=0:${videoDuration}[aout]`);
    
    command
      .complexFilter(filter)
      .outputOptions([
        '-map', '[vout]',
        '-map', '[aout]',
        '-pix_fmt', 'yuv420p',
        '-fps_mode', 'cfr'
      ])
      .videoCodec('libx264')
      .output(outputPath)
      .on('error', (err) => {
        reject(new Error(`FFmpeg error: ${err.message}`));
      })
      .on('end', () => {
        console.log('Slideshow created successfully');
        resolve();
      })
      .run();
  });
}

// Stream a file from a URL to the response
async function streamDownload(url, res, contentType, encodedFilename) {
  try {
    const downloadStream = got.stream(url, {
      timeout: {
        request: 120000
      },
      retry: {
        limit: 2
      }
    });
    
    // Set headers untuk client sebelum streaming dimulai
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);
    res.setHeader('X-Filename', encodedFilename);
    
    // Buat transform stream untuk mengontrol header
    const headerControlTransform = new Transform({
      transform(chunk, encoding, callback) {
        callback(null, chunk);
      }
    });
    
    let headersSet = false;
    
    downloadStream.on('response', (response) => {
      // Hanya set Content-Length, jangan copy header lain yang bisa override
      const contentLength = response.headers['content-length'];
      if (contentLength && !headersSet) {
        res.setHeader('Content-Length', contentLength);
      }
      headersSet = true;
    });
    
    downloadStream.on('error', (error) => {
      console.error('Error streaming file:', error);
      
      if (!res.headersSent) {
        res.status(500).json({
          error: error.message || 'Failed to download from source'
        });
      } else {
        res.end();
      }
    });
    
    // Pipeline: downloadStream -> transform -> response
    downloadStream
      .pipe(headerControlTransform)
      .pipe(res);
      
  } catch (error) {
    console.error('Error in streamDownload:', error);
    
    if (!res.headersSent) {
      res.status(500).json({
        error: error.message || 'Failed to download from source'
      });
    } else {
      res.end();
    }
  }
}

// Modified fetchTikTokData with fallback support
async function fetchTikTokData(url, minimal = true) {
  try {
    // Try primary API first
    const apiURL = `${DOUYIN_API_URL}?url=${encodeURIComponent(url)}&minimal=${minimal ? 'true' : 'false'}`;
    
    const response = await got(apiURL, {
      // timeout: {
      //   request: 5000 // 120 seconds timeout
      // },
      // retry: {
      //   limit: 2
      // },
      responseType: 'json'
    });
    
    // console.log('✅ Primary API (DOUYIN) used successfully');
    return response.body;
    
  } catch (primaryError) {
   // console.warn('⚠️ Primary API failed, trying fallback:', primaryError.message);
    
    try {
      // Use fallback API
      const fallbackData = await fallbackDownloader.fetchTikTokData(url, minimal);
      // console.log('✅ Fallback API (TikWM) used successfully');
      return fallbackData;
      
    } catch (fallbackError) {
      // console.error('❌ Both APIs failed');
      // console.error('Primary error:', primaryError.message);
      // console.error('Fallback error:', fallbackError.message);
      
      throw new Error(`All APIs failed. Primary: ${primaryError.message}, Fallback: ${fallbackError.message}`);
    }
  }
}

// Generate JSON response matching the second file format
function generateJsonResponse(data, url = '') {
  const videoData = data.data;
  const author = videoData.author;
  const statistics = videoData.statistics;
  const musicUrl = videoData.music?.play_url?.uri || videoData.music?.play_url?.url_list?.[0] || videoData.music?.play_url?.url || '';
  const isImage = videoData.type === 'image';

  const filteredAuthor = {
    nickname: author.nickname,
    signature: author.signature,
    avatar: author.avatar_thumb?.url_list?.[0] || ''
  };

  let picker = [];
  let metadata = {
    title: videoData.desc,
    description: videoData.desc,
    statistics: {
      repost_count: statistics.repost_count,
      comment_count: statistics.comment_count,
      digg_count: statistics.digg_count,
      play_count: statistics.play_count
    },
    artist: author.nickname,
    cover: videoData.cover_data?.cover?.url_list?.[0],
    duration: videoData.duration,
    audio: musicUrl,
    download_link: {},
    music_duration: videoData.music?.duration,
    author: filteredAuthor
  };

  if (isImage) {
    const imageUrls = videoData.image_data;
    picker = imageUrls.no_watermark_image_list.map(url => ({
      type: 'photo',
      url: url
    }));

    const encryptedNoWatermarkUrls = imageUrls.no_watermark_image_list.map(url =>
      encrypt(JSON.stringify({ url, author: author.nickname, type: 'image' }), ENCRYPTION_KEY, 360)
    );

    metadata.download_link.mp3 = `${BASE_URL}/download?data=${encrypt(JSON.stringify({url: musicUrl, author: author.nickname, type: 'mp3' }), ENCRYPTION_KEY, 360)}`;

    metadata.download_link.no_watermark = encryptedNoWatermarkUrls.map(
      encryptedUrl => `${BASE_URL}/download?data=${encryptedUrl}`
    );
    
    metadata.download_slideshow_link = `${BASE_URL}/download-slideshow?url=${encrypt(url, ENCRYPTION_KEY, 360)}`;
    
  } else {
    const videoUrls = videoData.video_data;

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

    metadata.download_link = {
      watermark: generateDownloadLink(videoUrls.wm_video_url, 'video'),
      watermark_hd: generateDownloadLink(videoUrls.wm_video_url_HQ, 'video'),
      no_watermark: generateDownloadLink(videoUrls.nwm_video_url, 'video'),
      no_watermark_hd: generateDownloadLink(videoUrls.nwm_video_url_HQ, 'video'),
      mp3: generateDownloadLink(musicUrl, 'mp3')
    };

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

// ================== API ROUTES ==================

// TikTok URL processing endpoint
app.post('/tiktok', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }
    
    if (!url.includes('tiktok.com') && !url.includes('douyin.com')) {
      return res.status(400).json({ error: 'Only TikTok and Douyin URLs are supported' });
    }
    
    let response;
    
    try {
      // Try primary TikTok API
      response = await generateTiktokResponse(url, {
        version: "v1",
        cookie: "delay_guest_mode_vid=5;tt-target-idc-sign=Eu-7PTNQSMLQCGZHkZtYmMOonVVebB2qkF8qGvvnTrKrTBap8fPadCld83tmWTIEGHEgZIusdK5HBp1hQpZb3VX5g46TSRXv6PQPkBeXVdlCDLQeRnQFZaKd5QiBhflnWw8tAWYFk1AuBoncPMfIpxKMHfke8IgOJC3CN6aydMy7aTzyhct4xLFgmxQaaRghJ3qVc400iReU2iLPaJzTX2v4n53EaU7m9Ab9-e2F-7PkLoXZyP6DEx2tNFqMbX3eXQJ3VwiEeQXPkhjESlzQXObv6eAgEjdNDxJcD_jmh-KWC8gNE7XWJDCMIOUL8NGVk75i0ZlS6agBVKaJwuoG8-9gGEVTllpsRblSr3FEivwEvGiABZtctoeGVyPN93TteT9mjexlfilsxedzjXlM6nIxDtqZ4A8Hj0O7Gpc-DyN17hPan1s7GcVf9HKCQzNqiPpOjygRtfj6K-NhwOwFnHt5fbsQxCKZf7WXnwPdZbsw4fWP_pkOLVIDEN2Ywi-w;msToken=7Xhm-TTunPrEE--WXnYIzScbHI_uItrHAytiDv5Q2Nl5aUAyPrUMGaK0Kbd0NzKu_Zio0jxLy6i7WTD7zy2R13n_Pgx8HshbCLo30VoMYbNrRY74mDcj3NiRd8cKN3jFmyJVjAQJUw==;sid_guard=b6a45debd08d45d91900cce679ad258b%7C1745777637%7C15551996%7CFri%2C+24-Oct-2025+18%3A13%3A53+GMT;ttwid=1%7C8nIrnSg0iT2WTdOFVc_fmEGYyOuqvoFRog7KzlMMpT4%7C1745777644%7Cf025ae406b97534941fb43bcdf42183521c8f9498332fe608e9315b7e8e002ce;store-country-code-src=uid;perf_feed_cache={%22expireTimestamp%22:1745949600000%2C%22itemIds%22:[%227479345522164174087%22%2C%227480872211373411589%22%2C%227494525854916168978%22]};uid_tt=935ab8cc560180239f3e0c75e5b435c127621b1080151bce4b2f47d7f1931f80;passport_csrf_token_default=cb464025914433ef62f8fdc779950386;store-country-sign=MEIEDKPog9ya0yXyPPJwhgQgnCQi9UVHLaLY7njJpTK80t3gaZ7rptp_R2X6-K40ER8EEG1EdSKPcLPwToFB5DBJGTg;msToken=HWjxNChMGSpW71ZPfsk2quVb_HGjLF1g_RkuRkDafMVbKyCU6PotTvYWPmOc28Osow2RsbA1y-Cj5hEdU24CiKjsJBIsFDj6umPoLoDWI_MGez1BiyuKBUI-SzpndcpGxOX9l07LaQ==;s_v_web_id=verify_m8t4rr0k_VC2pLfQU_NWqf_4BGY_ACK1_RntXpGbJ7ufc;store-idc=alisg;ssid_ucp_v1=1.0.0-KDRmOGU5NTFhYjZmM2Y1M2RlOTliNjg4OWQ0YjY3ZGRiYTllMGI3Y2UKGQiUiMLc69LD6GcQ5ee5wAYYsws4CEASSAQQAxoCbXkiIGI2YTQ1ZGViZDA4ZDQ1ZDkxOTAwY2NlNjc5YWQyNThi;tiktok_webapp_theme=dark;cmpl_token=AgQQAPOgF-RO0rfv4DEzol0t_Yd0lmST_4UrYNhhkQ;last_login_method=google;multi_sids=7480776496593798164%3Ab6a45debd08d45d91900cce679ad258b;odin_tt=e9eaa9cb36df6805036ac24dad5eb3d6f71982050c65db792fe9b1c012bfb5b8a9087cb81235953394cd19eafe38baffa0719a854317d81a7bc283740161404b65539b67fa5b38433106da9c1e7d5eb4;passport_auth_status=d280e9f317649d8a04299fe030a519ad%2C52a91fd8e290dd33d8094fecea733e63;passport_auth_status_ss=d280e9f317649d8a04299fe030a519ad%2C52a91fd8e290dd33d8094fecea733e63;passport_csrf_token=cb464025914433ef62f8fdc779950386;passport_fe_beating_status=true;sessionid=b6a45debd08d45d91900cce679ad258b;sessionid_ss=b6a45debd08d45d91900cce679ad258b;sid_tt=b6a45debd08d45d91900cce679ad258b;sid_ucp_v1=1.0.0-KDRmOGU5NTFhYjZmM2Y1M2RlOTliNjg4OWQ0YjY3ZGRiYTllMGI3Y2UKGQiUiMLc69LD6GcQ5ee5wAYYsws4CEASSAQQAxoCbXkiIGI2YTQ1ZGViZDA4ZDQ1ZDkxOTAwY2NlNjc5YWQyNThi;store-country-code=id;tiktok_webapp_theme_source=auto;tt-target-idc=alisg;tt_chain_token=lk9As53N10TXpYWZJdFgvw==;tt_csrf_token=7RYo65fY-jfPl_Tqp6sdo2ldG5kcI-Q_2aIc;uid_tt_ss=935ab8cc560180239f3e0c75e5b435c127621b1080151bce4b2f47d7f1931f80",
        showOriginalResponse: true
      });
      
    } catch (primaryError) {
      
      try {
        // Fallback to alternative downloader
        const minimal = true; // Set to true if you want minimal data
        const fallbackData = await fallbackDownloader.fetchTikTokData(url, minimal);
        response = generateJsonResponse(fallbackData, url);
        
        
      } catch (fallbackError) {
        throw new Error(`Both primary and fallback downloaders failed. Primary: ${primaryError.message}, Fallback: ${fallbackError.message}`);
      }
    }
    
    return res.status(200).json(response);
    
  } catch (error) {
    console.error('Error in TikTok handler:', error);
    return res.status(500).json({ error: error.message || 'An error occurred processing the request' });
  }
});

// File download endpoint
app.get('/download', async (req, res) => {
  try {
    const { data } = req.query;
    
    if (!data) {
      return res.status(400).json({ error: 'Encrypted data parameter is required' });
    }
    
    const decryptedData = decrypt(data, ENCRYPTION_KEY);
    const downloadData = JSON.parse(decryptedData);
    
    if (!downloadData.url || !downloadData.author || !downloadData.type) {
      return res.status(400).json({ error: 'Invalid decrypted data: missing url, author, or type' });
    }
    
    if (!contentTypes[downloadData.type]) {
      return res.status(400).json({ error: 'Invalid file type specified' });
    }
    
    const [contentType, fileExtension] = contentTypes[downloadData.type];
    
    const filename = `${downloadData.author}.${fileExtension}`;
    const encodedFilename = encodeURIComponent(filename);
    
    await streamDownload(downloadData.url, res, contentType, encodedFilename);
  } catch (error) {
    console.error('Error in download handler:', error);
    
    if (!res.headersSent) {
      return res.status(500).json({ error: error.message || 'An error occurred processing the download' });
    }
  }
});

// Slideshow download endpoint - modified to use fallback
app.get('/download-slideshow', async (req, res) => {
  let workDir = '';

  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }
    
    const decryptedURL = decrypt(url, ENCRYPTION_KEY);
    
    // Use fetchTikTokData with fallback support
    const data = await fetchTikTokData(decryptedURL, true);
    
    if (!data || !data.data) {
      return res.status(500).json({ error: 'Invalid response from API' });
    }
    
    const videoData = data.data;
    
    const isImage = videoData.type === 'image';
    
    if (!isImage) {
      return res.status(400).json({ error: 'Only image posts are supported' });
    }
    
    const awemeId = videoData.aweme_id || 'unknown';
    const authorUid = videoData.author?.uid || 'unknown';
    const folderName = `${awemeId}_${authorUid}_${Date.now()}`;
    workDir = path.join(tempDir, folderName);
    
    await fs.ensureDir(workDir);
    
    try {
      const imageURLs = videoData.image_data?.no_watermark_image_list || [];
      
      if (imageURLs.length === 0) {
        throw new Error('No images found');
      }
      
      let audioURL = '';
      if (videoData.music && videoData.music.play_url) {
        audioURL = videoData.music.play_url.url_list?.[0] || videoData.music.play_url.url || '';
      }
      
      if (!audioURL) {
        throw new Error('Could not find audio URL');
      }
      
      const downloadToPath = async (url, filePath) => {
        try {
          const writeStream = fs.createWriteStream(filePath);
          
          await new Promise((resolve, reject) => {
            const downloadStream = got.stream(url, {
              timeout: {
                request: 120000
              },
              retry: {
                limit: 2
              }
            });
            
            downloadStream.pipe(writeStream);
            
            downloadStream.on('error', (error) => {
              reject(error);
            });
            
            writeStream.on('finish', () => {
              resolve();
            });
            
            writeStream.on('error', (error) => {
              reject(error);
            });
          });
          
          return filePath;
        } catch (error) {
          throw new Error(`Failed to download file (${url}): ${error.message}`);
        }
      };
      
      const audioPath = path.join(workDir, 'audio.mp3');
      const audioTask = downloadToPath(audioURL, audioPath);
      
      const imageDownloadTasks = imageURLs.map((imageUrl, index) => {
        const imagePath = path.join(workDir, `image_${index}.jpg`);
        return downloadToPath(imageUrl, imagePath);
      });
      
      const [imagePaths] = await Promise.all([
        Promise.all(imageDownloadTasks),
        audioTask
      ]);
      
      const outputPath = path.join(workDir, 'slideshow.mp4');
      await createSlideshow(imagePaths, audioPath, outputPath);
      
      const authorNickname = videoData.author?.nickname || 'unknown';
      
      const sanitized = authorNickname.replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `${sanitized}_${Date.now()}.mp4`;
      
      const stats = await fs.stat(outputPath);
      
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', stats.size);
      
      const fileStream = createReadStream(outputPath);
      
      fileStream.on('end', () => {
        console.log('File stream ended, cleaning up folder');
        cleanupFolder(workDir);
      });
      
      fileStream.on('error', (error) => {
        console.error('Error streaming file:', error);
        cleanupFolder(workDir);
      });
      
      res.on('close', () => {
        if (!res.writableEnded) {
          console.log('Client disconnected before download completed, cleaning up');
          cleanupFolder(workDir);
        }
      });
      
      fileStream.pipe(res);
      
    } catch (error) {
      console.error('Error processing slideshow:', error);
      if (workDir) {
        await cleanupFolder(workDir);
      }
      throw error;
    }
  } catch (error) {
    console.error('Error in slideshow handler:', error);
    if (workDir) {
      await cleanupFolder(workDir);
    }
    return res.status(500).json({ error: error.message || 'An error occurred creating the slideshow' });
  }
});

// Health check endpoint - now shows which API is working
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    time: new Date().toISOString(),
    apis: {
      primary: 'unknown',
      fallback: 'unknown'
    }
  };

  // Test primary API
  try {
    const testUrl = `${DOUYIN_API_URL}?url=test&minimal=true`;
    await got(testUrl, { timeout: { request: 5000 }, retry: { limit: 0 } });
    health.apis.primary = 'online';
  } catch (error) {
    health.apis.primary = 'offline';
  }

  // Test fallback API
  try {
    await fallbackDownloader.client.get('/');
    health.apis.fallback = 'online';
  } catch (error) {
    health.apis.fallback = 'offline';
  }

  res.status(200).json(health);
});

// Add 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Unexpected server error',
    message: err.message
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Temp directory: ${tempDir}`);
  console.log(`Primary API URL: ${DOUYIN_API_URL}`);
  console.log(`Fallback API: TikWM.com`);
  console.log(`Fallback Proxy: ${fallbackDownloader.proxy}`);
});