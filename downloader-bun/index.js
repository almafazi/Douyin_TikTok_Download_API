import express from 'express';
import tmp from 'tmp';
import cors from 'cors';
import { encrypt, decrypt } from './crypto.js';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import bodyParser from 'body-parser';
import { pipeline } from 'stream/promises';

const app = express();
ffmpeg.setFfmpegPath('ffmpeg');

const BASE_URL = process.env.BASE_URL;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'overflow'; // Better to use env var
const ALLOWED_ORIGINS = ['http://localhost', 'http://127.0.0.1', 'https://snaptik.fit'];

// Temp file cleanup configuration
tmp.setGracefulCleanup(); // Enable auto-cleanup on process exit

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
    limit: '5mb', // Reduced from 10mb for security
    strict: true,
    verify: (req, res, buf, encoding) => {
      try {
        JSON.parse(buf.toString());
      } catch (e) {
        console.error('Invalid JSON:', buf.toString().substring(0, 100)); // Log just the beginning for security
        throw new Error('Invalid JSON');
      }
    }
}));

app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));

// Request timeout middleware
const timeoutMiddleware = (req, res, next) => {
  // Set timeout for all requests
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

    // // Basic TikTok URL validation
    // if (!url.match(/^https:\/\/(www\.)?(tiktok\.com|vm\.tiktok\.com)/)) {
    //     return res.status(400).json({ error: 'Invalid TikTok URL' });
    // }

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

// GET endpoint at /download
app.get('/download', async (req, res) => {
    const encryptedData = req.query.data;
    let fileResponse = null;

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
        fileResponse = await fetch(url, { signal });

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
            'Transfer-Encoding': 'chunked' // Explicitly use chunked encoding
        });

        // Stream the file directly to the client using stream pipeline
        if (fileResponse.body) {
            try {
                await pipeline(
                    fileResponse.body,
                    res
                );
            } catch (error) {
                // This will catch stream errors, including client disconnects
                if (!res.headersSent) {
                    console.error('Stream error:', error);
                    res.status(500).end();
                }
            }
        } else {
            throw new Error('Response body is null');
        }
    } catch (error) {
        console.error('Error downloading file:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to download file' });
        }
    } finally {
        // Clean up resources even if client disconnects
        if (fileResponse && fileResponse.body) {
            try {
                // Ensure the stream is closed if it hasn't been fully consumed
                fileResponse.body.cancel();
            } catch (e) {
                console.error('Error closing response stream:', e);
            }
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

// Improved downloadFile function with better resource management
const downloadFile = async (url, outputPath, abortSignal) => {
    let response = null;
    let writer = null;
    
    try {
        response = await axios({
            url,
            responseType: "stream",
            signal: abortSignal,
            timeout: 30000 // 30 second timeout
        });
        
        writer = fs.createWriteStream(outputPath);
        
        // Set up Promise with proper cleanup
        return new Promise((resolve, reject) => {
            // Pipe the data
            response.data.pipe(writer);
            
            // Handle success
            writer.on("finish", () => {
                writer.close();
                resolve();
            });
            
            // Handle errors
            writer.on("error", (err) => {
                cleanupResources();
                reject(err);
            });
            
            // Handle request abortion
            if (abortSignal) {
                abortSignal.addEventListener('abort', () => {
                    cleanupResources();
                    reject(new Error('Download aborted'));
                });
            }
            
            // Cleanup function to prevent memory leaks
            function cleanupResources() {
                if (writer) {
                    writer.close();
                    writer = null;
                }
                
                if (response && response.data) {
                    response.data.destroy();
                }
                
                // Delete the partial file if it exists
                try {
                    if (fs.existsSync(outputPath)) {
                        fs.unlinkSync(outputPath);
                    }
                } catch (unlinkError) {
                    console.error(`Failed to delete partial file ${outputPath}:`, unlinkError);
                }
            }
        });
    } catch (error) {
        // Clean up resources in case of axios error
        if (response && response.data) {
            response.data.destroy();
        }
        
        if (writer) {
            writer.close();
        }
        
        // Delete the partial file if it exists
        try {
            if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
            }
        } catch (unlinkError) {
            console.error(`Failed to delete partial file ${outputPath}:`, unlinkError);
        }
        
        throw error;
    }
};
  
// Improved createSlideshow function with better resource management
const createSlideshow = async (images, audioUrl, outputPath, abortSignal) => {
    let ffmpegProcess = null;
    
    return new Promise((resolve, reject) => {
        try {
            const command = ffmpeg();
            
            // Add images with loop and duration
            images.forEach((image) => {
                command.input(image).inputOptions(['-loop 1', '-t 3']);
            });
            
            // Add audio input with loop option
            command.input(audioUrl).inputOptions(['-stream_loop -1']); // -1 means infinite loop
            
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
            
            ffmpegProcess = command
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
                .on('error', (err) => {
                    cleanupOnError();
                    reject(err);
                });
            
            // Set up abort handling
            if (abortSignal) {
                abortSignal.addEventListener('abort', () => {
                    cleanupOnError();
                    reject(new Error('Slideshow creation aborted'));
                });
            }
            
            ffmpegProcess.run();
        } catch (error) {
            cleanupOnError();
            reject(error);
        }
        
        // Function to clean up resources on error
        function cleanupOnError() {
            if (ffmpegProcess) {
                try {
                    ffmpegProcess.kill('SIGKILL'); // Forcefully terminate ffmpeg
                } catch (killError) {
                    console.error('Error killing ffmpeg process:', killError);
                }
            }
            
            // Try to delete output file if it exists
            try {
                if (fs.existsSync(outputPath)) {
                    fs.unlinkSync(outputPath);
                }
            } catch (unlinkError) {
                console.error(`Failed to delete output file ${outputPath}:`, unlinkError);
            }
        }
    });
};
  
// Improved download-slideshow endpoint with parallel downloads and better resource management
app.get("/download-slideshow", async (req, res) => {
    let { url } = req.query;
    let tmpDir = null;
    let fileStream = null;

    if (!url) {
        return res.status(400).json({ error: "URL parameter is required" });
    }

    // Create a controller to abort operations if client disconnects
    const abortController = new AbortController();
    const signal = abortController.signal;
    
    // Handle client disconnect
    const onClose = () => {
        abortController.abort();
        cleanup();
        res.removeListener('close', onClose);
    };
    res.on('close', onClose);

    // Function to clean up all resources
    const cleanup = () => {
        // Close file stream if it exists
        if (fileStream) {
            try {
                fileStream.destroy();
            } catch (streamError) {
                console.error("Error closing file stream:", streamError);
            }
        }
        
        // Remove temporary directory and all contents
        if (tmpDir) {
            try {
                tmpDir.removeCallback();
            } catch (cleanupError) {
                console.error("Error cleaning up temp directory:", cleanupError);
            }
        }
    };

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
    
        // Create a unique temporary directory for files
        tmpDir = tmp.dirSync({ unsafeCleanup: true }); // Will be cleaned up automatically
        const tmpDirPath = tmpDir.name;
    
        // Download images in parallel
        const imageUrls = data.image_data.no_watermark_image_list;
        const downloadImagePromises = imageUrls.map((imageUrl, i) => {
            const imagePath = path.join(tmpDirPath, `image_${i}.jpg`);
            return downloadFile(imageUrl, imagePath, signal)
                .then(() => imagePath)
                .catch(error => {
                    // Clean up this specific file if download fails
                    try {
                        if (fs.existsSync(imagePath)) {
                            fs.unlinkSync(imagePath);
                        }
                    } catch (cleanupErr) {
                        console.error(`Failed to clean up image file ${imagePath}:`, cleanupErr);
                    }
                    throw error; // Re-throw to be caught by Promise.all
                });
        });

        const imagePaths = await Promise.all(downloadImagePromises);
    
        // Download audio
        const audioUrl = data.music.play_url.url_list[0];
        const audioPath = path.join(tmpDirPath, "audio.mp3");
        await downloadFile(audioUrl, audioPath, signal);
    
        // Create slideshow video
        const outputPath = path.join(tmpDirPath, "slideshow.mp4");
        await createSlideshow(imagePaths, audioPath, outputPath, signal);
    
        // Generate a unique download filename
        const authorNickname = data.author.nickname.replace(/[^a-zA-Z0-9]/g, '_');
        const uniqueFilename = `${authorNickname}_${Date.now()}.mp4`;
    
        // Stream the file to the client
        fileStream = fs.createReadStream(outputPath);
        
        res.set({
            'Content-Type': 'video/mp4',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(uniqueFilename)}"`,
            'Transfer-Encoding': 'chunked'
        });
        
        // Use pipeline for proper stream handling
        await pipeline(fileStream, res);
        
    } catch (error) {
        console.error("Error:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: "Failed to create slideshow" });
        }
    } finally {
        // Ensure all resources are cleaned up
        cleanup();
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