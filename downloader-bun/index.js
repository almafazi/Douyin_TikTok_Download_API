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
  decrypt,
} from './encryption.js';
import { createReadStream } from 'fs';
import got from 'got';
import { Transform } from 'stream';
import {
  generateTiktokResponse as generateHybridResponse,
  getHybridApiData,
  isRedisReady as isHybridRedisReady
} from './tiktok-hybrid.js';
dotenv.config();
// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);
initCleanupSchedule('*/15 * * * *');

// Environment variables (normally in .env file)
const PORT = process.env.PORT || 3021;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3021';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'overflow';
const DOUYIN_API_URL = process.env.DOUYIN_API_URL || 'http://127.0.0.1:3035/api/hybrid/video_data';
const TIKTOK_PROVIDER = String(process.env.TIKTOK_PROVIDER || 'hybrid').toLowerCase();
const ALLOW_PROVIDER_OVERRIDE = String(process.env.ALLOW_PROVIDER_OVERRIDE || 'false').toLowerCase() === 'true';
const LIBRARY_TIMEOUT_MS = parseInt(process.env.LIBRARY_TIMEOUT_MS || '12000', 10);
const LIBRARY_FALLBACK_TO_HYBRID = String(process.env.LIBRARY_FALLBACK_TO_HYBRID || 'true').toLowerCase() === 'true';
const VALID_PROVIDERS = ['hybrid', 'library'];

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

function normalizeProvider(provider) {
  const normalized = String(provider || '').toLowerCase().trim();
  if (normalized === 'hybrid-api') {
    return 'hybrid';
  }
  if (VALID_PROVIDERS.includes(normalized)) {
    return normalized;
  }
  return null;
}

function resolveProvider(requestMethod) {
  const configuredProvider = normalizeProvider(TIKTOK_PROVIDER) || 'hybrid';
  const requestProvider = normalizeProvider(requestMethod);

  if (ALLOW_PROVIDER_OVERRIDE && requestProvider) {
    return requestProvider;
  }

  return configuredProvider;
}

async function generateLibraryResponse(url) {
  const libraryModule = await import('./tiktok-library.js');
  return libraryModule.generateTiktokResponse(url, {
    version: 'v1',
    showOriginalResponse: true
  });
}

async function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function generateTikTokResponseByProvider(url, provider) {
  if (provider === 'library') {
    try {
      return await withTimeout(
        generateLibraryResponse(url),
        LIBRARY_TIMEOUT_MS,
        `library provider timed out after ${LIBRARY_TIMEOUT_MS}ms`
      );
    } catch (error) {
      if (!LIBRARY_FALLBACK_TO_HYBRID) {
        throw error;
      }
      console.warn(`[Provider Fallback] library failed, fallback to hybrid: ${error.message}`);
      return generateHybridResponse(url, { minimal: true });
    }
  }
  return generateHybridResponse(url, { minimal: true });
}

async function downloadFile(url, outputPath, options = {}) {
  const { signal } = options;
  const cleanupPartial = () => fs.remove(outputPath).catch(() => {});

  try {
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(outputPath);
      const downloadStream = got.stream(url, {
        timeout: {
          request: 120000 // 120 seconds timeout
        },
        retry: {
          limit: 2
        },
        signal
      });

      const handleError = (error) => {
        downloadStream.destroy();
        writeStream.destroy();
        cleanupPartial().finally(() => reject(error));
      };

      downloadStream.pipe(writeStream);

      downloadStream.on('error', handleError);
      writeStream.on('error', handleError);
      writeStream.on('finish', resolve);
    });

    return outputPath;
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'CancelError') {
      throw error;
    }
    throw new Error(`Failed to download file: ${error.message}`);
  }
}

// Create a slideshow from images and audio
function createSlideshow(imagePaths, audioPath, outputPath, options = {}) {
  const { onCommand, signal } = options;

  return new Promise((resolve, reject) => {
    const command = ffmpeg();
    let settled = false;

    if (typeof onCommand === 'function') {
      onCommand(command);
    }

    const finish = (callback) => (value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      callback(value);
    };

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        command.kill('SIGKILL');
      } catch (abortError) {
        // Ignore kill errors; command may already be stopped
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      reject(new Error('Slideshow rendering aborted'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
    }

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
      .on('error', finish((err) => {
        reject(new Error(`FFmpeg error: ${err.message}`));
      }))
      .on('end', finish(() => {
        console.log('Slideshow created successfully');
        resolve();
      }))
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

    const handleClose = () => {
      if (!downloadStream.destroyed) {
        downloadStream.destroy(new Error('Client closed connection'));
      }
      headerControlTransform.destroy();
    };
    
    res.once('close', handleClose);
    
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
      res.removeListener('close', handleClose);
      
      if (!res.headersSent) {
        res.status(500).json({
          error: error.message || 'Failed to download from source'
        });
      } else {
        res.end();
      }
    });

    downloadStream.on('end', () => {
      res.removeListener('close', handleClose);
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

// ================== API ROUTES ==================

// TikTok URL processing endpoint
app.post('/tiktok', async (req, res) => {
  try {
    const { url, method } = req.body;
    const selectedProvider = resolveProvider(method);

    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    if (!selectedProvider) {
      return res.status(400).json({
        error: `Invalid provider. Valid providers: ${VALID_PROVIDERS.join(', ')}`
      });
    }

    if (!url.includes('tiktok.com') && !url.includes('douyin.com')) {
      return res.status(400).json({ error: 'Only TikTok and Douyin URLs are supported' });
    }

    const response = await generateTikTokResponseByProvider(url, selectedProvider);

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
  const jobAbortController = new AbortController();
  let workDir = '';
  let ffmpegCommand = null;
  let fileStream = null;
  let tempCleaned = false;

  const cleanupTempDir = async () => {
    if (tempCleaned || !workDir) {
      return;
    }
    tempCleaned = true;
    try {
      await cleanupFolder(workDir);
    } catch (cleanupError) {
      console.error('Error removing temp folder:', cleanupError);
    }
  };

  const detachListeners = () => {
    req.removeListener('close', onRequestClose);
    res.removeListener('close', onResponseClose);
  };

  const cancelJob = async () => {
    if (!jobAbortController.signal.aborted) {
      jobAbortController.abort();
    }

    if (ffmpegCommand) {
      try {
        ffmpegCommand.kill('SIGKILL');
      } catch (error) {
        // Ignore kill errors; command may have already exited
      } finally {
        ffmpegCommand = null;
      }
    }

    if (fileStream) {
      fileStream.destroy();
      fileStream = null;
    }

    await cleanupTempDir();
    detachListeners();
  };

  function onRequestClose() {
    cancelJob().catch((err) => {
      console.error('Error cancelling slideshow job:', err);
    });
  }

  function onResponseClose() {
    if (!res.writableEnded) {
      onRequestClose();
    }
  }

  req.on('close', onRequestClose);
  res.on('close', onResponseClose);

  try {
    const { url } = req.query;

    if (!url) {
      await cleanupTempDir();
      detachListeners();
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    const decryptedURL = decrypt(url, ENCRYPTION_KEY);

    const data = await getHybridApiData(decryptedURL, true);

    if (!data || !data.data) {
      await cleanupTempDir();
      detachListeners();
      return res.status(500).json({ error: 'Invalid response from API' });
    }

    const videoData = data.data;

    const isImage = videoData.type === 'image';

    if (!isImage) {
      await cleanupTempDir();
      detachListeners();
      return res.status(400).json({ error: 'Only image posts are supported' });
    }

    const awemeId = videoData.aweme_id || 'unknown';
    const authorUid = videoData.author?.uid || 'unknown';
    const folderName = `${awemeId}_${authorUid}_${Date.now()}`;
    workDir = path.join(tempDir, folderName);

    await fs.ensureDir(workDir);

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

    const audioPath = path.join(workDir, 'audio.mp3');
    const audioTask = downloadFile(audioURL, audioPath, { signal: jobAbortController.signal });

    const imageDownloadTasks = imageURLs.map((imageUrl, index) => {
      const imagePath = path.join(workDir, `image_${index}.jpg`);
      return downloadFile(imageUrl, imagePath, { signal: jobAbortController.signal });
    });

    const [imagePaths] = await Promise.all([
      Promise.all(imageDownloadTasks),
      audioTask
    ]);

    const outputPath = path.join(workDir, 'slideshow.mp4');
    await createSlideshow(imagePaths, audioPath, outputPath, {
      signal: jobAbortController.signal,
      onCommand: (command) => {
        ffmpegCommand = command;
      }
    });
    ffmpegCommand = null;

    const authorNickname = videoData.author?.nickname || 'unknown';

    const sanitized = authorNickname.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `${sanitized}_${Date.now()}.mp4`;

    const stats = await fs.stat(outputPath);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stats.size);

    fileStream = createReadStream(outputPath);

    fileStream.on('end', () => {
      fileStream = null;
      console.log('File stream ended, cleaning up folder');
      cleanupTempDir().finally(detachListeners);
    });

    fileStream.on('error', (error) => {
      console.error('Error streaming file:', error);
      cancelJob().catch((err) => {
        console.error('Error during cancellation after stream failure:', err);
      });
    });

    fileStream.pipe(res);

  } catch (error) {
    console.error('Error in slideshow handler:', error);

    if (jobAbortController.signal.aborted) {
      return;
    }

    await cleanupTempDir();
    detachListeners();

    if (!res.headersSent) {
      return res.status(500).json({ error: error.message || 'An error occurred creating the slideshow' });
    }
  }
});

// Health check endpoint - now shows which API is working
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    time: new Date().toISOString(),
    provider: resolveProvider(),
    allow_provider_override: ALLOW_PROVIDER_OVERRIDE,
    apis: {
      hybrid: 'unknown'
    },
    redis: isHybridRedisReady() ? 'online' : 'offline'
  };

  // Test hybrid API
  try {
    const testUrl = `${DOUYIN_API_URL}?url=test&minimal=true`;
    await got(testUrl, {
      timeout: { request: 5000 },
      retry: { limit: 0 },
      throwHttpErrors: false
    });
    health.apis.hybrid = 'online';
  } catch (error) {
    health.apis.hybrid = 'offline';
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
  console.log(`Hybrid API URL: ${DOUYIN_API_URL}`);
  console.log(`Hybrid module: tiktok-hybrid.js`);
  console.log(`TikTok provider: ${resolveProvider()} (env TIKTOK_PROVIDER=${TIKTOK_PROVIDER})`);
  console.log(`Provider override: ${ALLOW_PROVIDER_OVERRIDE ? 'enabled' : 'disabled'}`);
  console.log(`Library timeout: ${LIBRARY_TIMEOUT_MS}ms`);
  console.log(`Library fallback to hybrid: ${LIBRARY_FALLBACK_TO_HYBRID ? 'enabled' : 'disabled'}`);
});
