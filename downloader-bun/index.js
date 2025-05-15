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

dotenv.config();
// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);
initCleanupSchedule('*/15 * * * *');
// Environment variables (normally in .env file)
const PORT = process.env.PORT || 3021;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3021';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'overflow';
const DOUYIN_API_URL = process.env.DOUYIN_API_URL || 'http://127.0.0.1:3035/api/hybrid/video_data';

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
        '-fps_mode', 'cfr'  // Use -fps_mode cfr instead of -preset medium
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
    // Create download stream with a single request
    const downloadStream = got.stream(url, {
      timeout: {
        request: 120000 // 120 seconds timeout
      },
      retry: {
        limit: 2
      }
    });
    
    // Set initial headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);
    res.setHeader('X-Filename', encodedFilename);
    
    // When the response headers are received, set the Content-Length
    downloadStream.on('response', (response) => {
      const contentLength = response.headers['content-length'];
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }
    });
    
    // Handle errors
    downloadStream.on('error', (error) => {
      console.error('Error streaming file:', error);
      
      // If headers haven't been sent yet, send error response
      if (!res.headersSent) {
        res.status(500).json({
          error: error.message || 'Failed to download from source'
        });
      } else {
        // If headers have been sent, end the response
        res.end();
      }
    });
    
    // Pipe the stream to the response
    downloadStream.pipe(res);
  } catch (error) {
    console.error('Error in streamDownload:', error);
    
    // If headers haven't been sent yet, send error response
    if (!res.headersSent) {
      res.status(500).json({
        error: error.message || 'Failed to download from source'
      });
    } else {
      // If headers have been sent, end the response
      res.end();
    }
  }
}

// Fetch TikTok data from the hybrid API
async function fetchTikTokData(url, minimal = true) {
  try {
    const apiURL = `${DOUYIN_API_URL}?url=${encodeURIComponent(url)}&minimal=${minimal ? 'true' : 'false'}`;
    
    const response = await got(apiURL, {
      timeout: {
        request: 120000 // 120 seconds timeout
      },
      retry: {
        limit: 2
      },
      responseType: 'json'
    });
    
    return response.body;
  } catch (error) {
    console.error('Error fetching TikTok data:', error.message);
    throw new Error(`Failed to fetch data: ${error.message} ${url}`);
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

    // Generate encrypted download links for images
    const encryptedNoWatermarkUrls = imageUrls.no_watermark_image_list.map(url =>
      encrypt(JSON.stringify({ url, author: author.nickname, type: 'image' }), ENCRYPTION_KEY, 360)
    );

    // Generate MP3 download link
    metadata.download_link.mp3 = `${BASE_URL}/download?data=${encrypt(JSON.stringify({url: musicUrl, author: author.nickname, type: 'mp3' }), ENCRYPTION_KEY, 360)}`;

    // Add no watermark image links
    metadata.download_link.no_watermark = encryptedNoWatermarkUrls.map(
      encryptedUrl => `${BASE_URL}/download?data=${encryptedUrl}`
    );
    
    // Add slideshow download link
    metadata.download_slideshow_link = `${BASE_URL}/download-slideshow?url=${encrypt(url, ENCRYPTION_KEY, 360)}`;
    
  } else {
    const videoUrls = videoData.video_data;

    // Function to encrypt and generate download link if URL is not null
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

    // Generate download links only if URLs are not null
    metadata.download_link = {
      watermark: generateDownloadLink(videoUrls.wm_video_url, 'video'),
      watermark_hd: generateDownloadLink(videoUrls.wm_video_url_HQ, 'video'),
      no_watermark: generateDownloadLink(videoUrls.nwm_video_url, 'video'),
      no_watermark_hd: generateDownloadLink(videoUrls.nwm_video_url_HQ, 'video'),
      mp3: generateDownloadLink(musicUrl, 'mp3')
    };

    // Remove null values from the metadata.download_link object
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
    
    // Check if URL is from TikTok or Douyin
    if (!url.includes('tiktok.com') && !url.includes('douyin.com')) {
      return res.status(400).json({ error: 'Only TikTok and Douyin URLs are supported' });
    }
    
    // Fetch data from the hybrid API
    const data = await fetchTikTokData(url);
    
    // Process response using the new generateJsonResponse function
    const response = generateJsonResponse(data, url);
    
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
    
    // Decrypt the data
    const decryptedData = decrypt(data, ENCRYPTION_KEY);
    const downloadData = JSON.parse(decryptedData);
    
    if (!downloadData.url || !downloadData.author || !downloadData.type) {
      return res.status(400).json({ error: 'Invalid decrypted data: missing url, author, or type' });
    }
    
    // Determine content type and file extension
    if (!contentTypes[downloadData.type]) {
      return res.status(400).json({ error: 'Invalid file type specified' });
    }
    
    const [contentType, fileExtension] = contentTypes[downloadData.type];
    
    // Configure the filename
    const filename = `${downloadData.author}.${fileExtension}`;
    const encodedFilename = encodeURIComponent(filename);
    
    // Stream the file from source to client
    await streamDownload(downloadData.url, res, contentType, encodedFilename);
  } catch (error) {
    console.error('Error in download handler:', error);
    
    if (!res.headersSent) {
      return res.status(500).json({ error: error.message || 'An error occurred processing the download' });
    }
  }
});

// Slideshow download endpoint
app.get('/download-slideshow', async (req, res) => {
    let workDir = '';

    try {
      const { url } = req.query;
      
      if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
      }
      
      // Decrypt the URL
      const decryptedURL = decrypt(url, ENCRYPTION_KEY);
      
      // Fetch data from the hybrid API
      const data = await fetchTikTokData(decryptedURL, true);
      
      if (!data || !data.data) {
        return res.status(500).json({ error: 'Invalid response from API' });
      }
      
      const videoData = data.data;
      
      // Check if it's an image post
      const isImage = videoData.type === 'image';
      
      if (!isImage) {
        return res.status(400).json({ error: 'Only image posts are supported' });
      }
      
      // Create a unique temp directory
      const awemeId = videoData.aweme_id || 'unknown';
      const authorUid = videoData.author?.uid || 'unknown';
      const folderName = `${awemeId}_${authorUid}_${Date.now()}`;
      workDir = path.join(tempDir, folderName);
      
      await fs.ensureDir(workDir);
      
      try {
        // Get image URLs
        const imageURLs = videoData.image_data?.no_watermark_image_list || [];
        
        if (imageURLs.length === 0) {
          throw new Error('No images found');
        }
        
        // Download images
        const imagePaths = [];
        for (let i = 0; i < imageURLs.length; i++) {
          const imagePath = path.join(workDir, `image_${i}.jpg`);
          await downloadFile(imageURLs[i], imagePath);
          imagePaths.push(imagePath);
        }
        
        // Get audio URL
        let audioURL = '';
        if (videoData.music && videoData.music.play_url) {
          audioURL = videoData.music.play_url.url_list?.[0] || videoData.music.play_url.url || '';
        }
        
        if (!audioURL) {
          throw new Error('Could not find audio URL');
        }
        
        // Download audio
        const audioPath = path.join(workDir, 'audio.mp3');
        await downloadFile(audioURL, audioPath);
        
        // Create slideshow
        const outputPath = path.join(workDir, 'slideshow.mp4');
        await createSlideshow(imagePaths, audioPath, outputPath);
        
        // Generate filename
        const authorNickname = videoData.author?.nickname || 'unknown';
        
        // Sanitize filename
        const sanitized = authorNickname.replace(/[^a-zA-Z0-9]/g, '_');
        const filename = `${sanitized}_${Date.now()}.mp4`;
        
        // Get file size to set content-length header
        const stats = await fs.stat(outputPath);
        
        // Set headers
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', stats.size);
        
        // Return the file using a stream to track when download finishes
        const fileStream = createReadStream(outputPath);
        
        // Track when the stream ends or errors
        fileStream.on('end', () => {
          console.log('File stream ended, cleaning up folder');
          // Cleanup after download completes
          cleanupFolder(workDir);
        });
        
        fileStream.on('error', (error) => {
          console.error('Error streaming file:', error);
          // Cleanup on streaming error
          cleanupFolder(workDir);
        });
        
        // Handle client disconnection
        res.on('close', () => {
          if (!res.writableEnded) {
            console.log('Client disconnected before download completed, cleaning up');
            cleanupFolder(workDir);
          }
        });
        
        // Pipe the file to the response
        fileStream.pipe(res);
        
      } catch (error) {
        console.error('Error processing slideshow:', error);
        // Cleanup on error
        if (workDir) {
          await cleanupFolder(workDir);
        }
        throw error;
      }
    } catch (error) {
      console.error('Error in slideshow handler:', error);
      // Cleanup on error if not already done
      if (workDir) {
        await cleanupFolder(workDir);
      }
      return res.status(500).json({ error: error.message || 'An error occurred creating the slideshow' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    time: new Date().toISOString()
  });
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
  console.log(`Hybrid API URL: ${DOUYIN_API_URL}`);
});