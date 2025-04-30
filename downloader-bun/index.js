import express from 'express';
import cors from 'cors';
import { encrypt, decrypt } from './crypto.js';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import bodyParser from 'body-parser';
import nodeCron from 'node-cron';

const app = express();
ffmpeg.setFfmpegPath('ffmpeg');

const BASE_URL = process.env.BASE_URL;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'overflow'; // Better to use env var
const ALLOWED_ORIGINS = ['http://localhost', 'http://127.0.0.1', 'https://snaptik.fit'];

// Temp directory setup - replacing tmp library with manual directory management
const TEMP_DIR = path.join(process.cwd(), 'temp_files');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  console.log(`Created temp directory at: ${TEMP_DIR}`);
}

// CORS middleware with specific origins
app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        // Check if origin is allowed
        const isAllowed = ALLOWED_ORIGINS.some(allowedOrigin => 
          origin.startsWith(allowedOrigin)
        );
        
        if (isAllowed) {
          callback(null, true);
        } else {
          callback(new Error('CORS not allowed'));
        }
      },
      exposedHeaders: ['content-disposition', 'x-filename'],
    })
);

// Request size limiting and JSON validation
app.use(express.json({
    limit: '5mb',
    strict: true,
    verify: (req, res, buf, encoding) => {
      try {
        JSON.parse(buf.toString());
      } catch (e) {
        console.error('Invalid JSON:', buf.toString().substring(0, 100));
        throw new Error('Invalid JSON');
      }
    }
}));

app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));

// Request timeout middleware
const timeoutMiddleware = (req, res, next) => {
  req.setTimeout(30000, () => {
    res.status(408).json({ error: 'Request timeout' });
  });
  next();
};

app.use(timeoutMiddleware);

// POST endpoint at /tiktok
app.post('/tiktok', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    try {
        // Create a controller to abort the fetch if needed
        const controller = new AbortController();
        const signal = controller.signal;
        
        // Set a timeout to abort the fetch after 15 seconds
        const timeout = setTimeout(() => controller.abort(), 15000);

        // Fetch data from localhost:3035/api/hybrid/video_data
        const response = await fetch(`http://127.0.0.1:3035/api/hybrid/video_data?url=${encodeURIComponent(url)}&minimal=true`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
            signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        // Generate JSON response
        const jsonResponse = generateJsonResponse(data, url);

        // Respond with the JSON content
        res.json(jsonResponse);
    } catch (error) {
        console.error('Error fetching data:', error.message);
        res.status(500).json({ error: 'Failed to fetch data from the external API' });
    }
});

// GET endpoint at /download - Modified to use pipe instead of pipeline
app.get('/download', async (req, res) => {
    const encryptedData = req.query.data;

    if (!encryptedData) {
        return res.status(400).json({ error: 'Encrypted data parameter is required' });
    }

    try {
        // Decrypt the data
        const decryptedData = decrypt(encryptedData, ENCRYPTION_KEY);
        const { url, author, type } = JSON.parse(decryptedData);

        if (!url || !author || !type) {
            throw new Error('Invalid decrypted data: missing url, author, or type');
        }

        // Create a controller to abort the fetch if needed
        const controller = new AbortController();
        const signal = controller.signal;
        
        // Set up client disconnect handler to abort the request
        const onClose = () => {
            controller.abort();
            res.removeListener('close', onClose);
        };
        res.on('close', onClose);

        // Fetch the file from the decrypted URL with timeout
        const fileResponse = await fetch(url, { signal });

        if (!fileResponse.ok) {
            throw new Error(`Failed to fetch file: ${fileResponse.statusText}`);
        }

        // Determine Content-Type and file extension based on the file type
        let contentType, fileExtension;
        if (type === 'mp3') {
            contentType = 'audio/mpeg';
            fileExtension = 'mp3';
        } else if (type === 'video') {
            contentType = 'video/mp4';
            fileExtension = 'mp4';
        } else if (type === 'image') {
            contentType = 'image/jpeg';
            fileExtension = 'jpg';
        } else {
            throw new Error('Invalid file type specified');
        }

        // Set headers for file download with the author's name in the filename
        const filename = `${author}.${fileExtension}`;
        const encodedFilename = encodeURIComponent(filename);

        // Set headers
        res.set({
            'x-filename': encodedFilename,
            'Content-Disposition': `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`,
            'Content-Type': contentType,
            'Transfer-Encoding': 'chunked'
        });

        // Direct stream the file to the client using readable.pipe() instead of pipeline
        if (fileResponse.body) {
            // Create a stream from fetch response body
            const { Readable } = await import('stream');
            const readableStream = Readable.fromWeb(fileResponse.body);
            
            // Handle stream errors
            readableStream.on('error', (error) => {
                console.error('Stream error:', error);
                if (!res.headersSent) {
                    res.status(500).end();
                }
            });
            
            // Pipe the stream to response
            readableStream.pipe(res);
        } else {
            throw new Error('Response body is null');
        }
    } catch (error) {
        console.error('Error downloading file:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to download file' });
        }
    }
});

const generateJsonResponse = (data, url = '') => {
    const videoData = data.data;
    const author = videoData.author;
    const statistics = videoData.statistics;
    const musicUrl = videoData.music.play_url.uri;
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
        cover: videoData.cover_data?.cover?.url_list[0],
        duration: videoData.duration,
        audio: musicUrl,
        download_link: {},
        music_duration: videoData.music.duration,
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

        // Function to encrypt and generate download link if URL is not null
        const generateDownloadLink = (url, author, type) => {
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
            watermark: generateDownloadLink(videoUrls.wm_video_url, author, 'video'),
            watermark_hd: generateDownloadLink(videoUrls.wm_video_url_HQ, author, 'video'),
            no_watermark: generateDownloadLink(videoUrls.nwm_video_url, author, 'video'),
            no_watermark_hd: generateDownloadLink(videoUrls.nwm_video_url_HQ, author, 'video'),
            mp3: generateDownloadLink(musicUrl, author, 'mp3')
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
};

// Refactored downloadToFile function using streams instead of pipeline
const downloadToFile = async (url, outputPath, signal) => {
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            signal,
            timeout: 30000
        });
        
        const writer = fs.createWriteStream(outputPath);
        
        return new Promise((resolve, reject) => {
            // Set up error handlers for both streams
            response.data.on('error', (err) => {
                writer.end();
                reject(err);
            });
            
            writer.on('error', (err) => {
                reject(err);
            });
            
            // Set up finish handler
            writer.on('finish', () => {
                resolve(outputPath);
            });
            
            // Pipe the data
            response.data.pipe(writer);
        });
    } catch (error) {
        // If file was partially created, delete it
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }
        throw error;
    }
};

// Simplified createSlideshow function
const createSlideshow = (images, audioPath, outputPath) => {
    return new Promise((resolve, reject) => {
        const command = ffmpeg();
        
        // Add images with loop and duration
        images.forEach((image) => {
            command.input(image).inputOptions(['-loop 1', '-t 3']);
        });
        
        // Add audio input with loop option
        command.input(audioPath).inputOptions(['-stream_loop -1']);
        
        // Build complex filter to scale/pad images and concatenate
        const filter = [];
        images.forEach((_, index) => {
            filter.push(
                `[${index}:v]scale=w=1080:h=1920:force_original_aspect_ratio=decrease,` +
                `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${index}]`
            );
        });
        
        // Concatenate all scaled/padded video streams
        const concatInputs = images.map((_, i) => `[v${i}]`).join('');
        filter.push(`${concatInputs}concat=n=${images.length}:v=1:a=0[vout]`);
        
        // Calculate the total duration of the video
        const videoDuration = images.length * 3; // 3 seconds per image
        
        // Add audio filter to trim the looping audio to the video duration
        filter.push(`[${images.length}:a]atrim=0:${videoDuration}[aout]`);
        
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
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
};

// Function to create a unique temporary directory for a TikTok
const createTempDir = (data) => {
    const dirId = `${data.aweme_id}_${data.author.uid}`;
    const dirPath = path.join(TEMP_DIR, dirId);
    
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    
    return {
        dirPath,
        dirId
    };
};

// Improved download-slideshow endpoint with direct streaming (without pipeline)
app.get("/download-slideshow", async (req, res) => {
    let { url } = req.query;
    let dirToCleanup = null;

    if (!url) {
        return res.status(400).json({ error: "URL parameter is required" });
    }

    // Create a controller to abort operations if client disconnects
    const abortController = new AbortController();
    const signal = abortController.signal;
    
    // Handle client disconnect
    const onClose = () => {
        abortController.abort();
        
        // Cleanup temp directory on disconnect
        if (dirToCleanup && fs.existsSync(dirToCleanup)) {
            try {
                fs.rmSync(dirToCleanup, { recursive: true, force: true });
                console.log(`Cleaned up directory after client disconnect: ${dirToCleanup}`);
            } catch (error) {
                console.error(`Failed to clean up directory after disconnect: ${dirToCleanup}`, error);
            }
        }
        
        res.removeListener('close', onClose);
    };
    res.on('close', onClose);

    try {
        // Decrypt the URL
        url = decrypt(url, ENCRYPTION_KEY);
        
        // Fetch data from localhost
        const response = await axios.get(
            `http://127.0.0.1:3035/api/hybrid/video_data?url=${encodeURIComponent(url)}&minimal=true`,
            { 
                timeout: 15000,
                signal: signal
            }
        );
    
        const data = response.data.data;
    
        if (data.type !== "image") {
            return res.status(400).json({ error: "Only image posts are supported" });
        }
        
        // Create temp directory based on aweme_id and author.uid
        const { dirPath, dirId } = createTempDir(data);
        dirToCleanup = dirPath; // Store for cleanup in case of errors
        
        const outputPath = path.join(dirPath, "slideshow.mp4");
        
        // Check if we need to generate the slideshow or if it already exists
        let needToGenerate = true;
        
        if (fs.existsSync(outputPath)) {
            // If file exists, we can use it directly
            needToGenerate = false;
        }
        
        // If we need to generate the slideshow
        if (needToGenerate) {
            // Download images in parallel using Promise.all
            const imageUrls = data.image_data.no_watermark_image_list;
            const downloadImagePromises = imageUrls.map((imageUrl, i) => {
                const imagePath = path.join(dirPath, `image_${i}.jpg`);
                return downloadToFile(imageUrl, imagePath, signal)
                    .then(() => imagePath)
                    .catch(error => {
                        console.error(`Failed to download image ${i}:`, error);
                        throw error; // Re-throw to be caught by Promise.all
                    });
            });

            const imagePaths = await Promise.all(downloadImagePromises);
        
            // Download audio
            const audioUrl = data.music.play_url.url_list[0];
            const audioPath = path.join(dirPath, "audio.mp3");
            await downloadToFile(audioUrl, audioPath, signal);
        
            // Create slideshow video
            await createSlideshow(imagePaths, audioPath, outputPath);
        }
    
        // Generate a nice filename for download
        const authorNickname = data.author.nickname.replace(/[^a-zA-Z0-9]/g, '_');
        const fileName = `${authorNickname}_slideshow.mp4`;
    
        // Stream the file to the client
        res.set({
            'Content-Type': 'video/mp4',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
            'Transfer-Encoding': 'chunked'
        });
        
        // Use createReadStream and pipe instead of pipeline
        const fileStream = fs.createReadStream(outputPath);
        
        fileStream.on('error', (error) => {
            console.error('Error streaming file:', error);
            if (!res.headersSent) {
                res.status(500).end();
            }
        });
        
        // Handle finish event to cleanup after streaming is done
        res.on('finish', () => {
            // After successful streaming, clean up the temp directory
            try {
                fs.rmSync(dirPath, { recursive: true, force: true });
                console.log(`Successfully removed temp directory after streaming: ${dirPath}`);
            } catch (cleanupError) {
                console.error(`Error cleaning up temp directory ${dirPath}:`, cleanupError);
            }
        });
        
        // Pipe the file to the response
        fileStream.pipe(res);
        
    } catch (error) {
        console.error("Error:", error);
        
        // Cleanup on error
        if (dirToCleanup && fs.existsSync(dirToCleanup)) {
            try {
                fs.rmSync(dirToCleanup, { recursive: true, force: true });
                console.log(`Cleaned up directory after error: ${dirToCleanup}`);
            } catch (cleanupError) {
                console.error(`Failed to clean up directory after error: ${dirToCleanup}`, cleanupError);
            }
        }
        
        if (!res.headersSent) {
            res.status(500).json({ error: "Failed to create slideshow" });
        }
    }
});

// Cleanup job for old temporary files
nodeCron.schedule('0 */1 * * *', () => {
    console.log('Running cleanup job for any remaining temporary files...');
    
    const currentTime = Date.now();
    const TWO_HOURS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
    
    // Read all directories in TEMP_DIR
    try {
        const dirs = fs.readdirSync(TEMP_DIR);
        
        dirs.forEach(dirName => {
            const dirPath = path.join(TEMP_DIR, dirName);
            
            // Check if it's a directory
            if (fs.statSync(dirPath).isDirectory()) {
                const stats = fs.statSync(dirPath);
                const fileAge = currentTime - stats.mtime.getTime();
                
                // If directory is older than 2 hours, delete it and its contents
                if (fileAge > TWO_HOURS) {
                    console.log(`Removing old temporary directory: ${dirPath}`);
                    fs.rmSync(dirPath, { recursive: true, force: true });
                }
            }
        });
        
        console.log('Cleanup completed.');
    } catch (error) {
        console.error('Error during cleanup:', error);
    }
});

// 404 middleware
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
    const errorInfo = {
        path: req.path,
        method: req.method,
        error: err.message,
        stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined
    };
    
    console.error('Unhandled error:', JSON.stringify(errorInfo));
    
    // Check if headers are already sent
    if (res.headersSent) {
        return next(err);
    }
    
    // Check if it's a CORS error
    if (err.message === 'CORS not allowed') {
        return res.status(403).json({
            error: 'Access forbidden',
            message: 'Origin not allowed'
        });
    }
    
    res.status(500).json({
        error: 'Unexpected server error',
        message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
    });
});

// Start the server
const PORT = process.env.PORT || 3029;
app.listen(PORT, 'localhost', () => { // Listen only on localhost interface
    console.log(`Server is running on http://localhost:${PORT}`);
});