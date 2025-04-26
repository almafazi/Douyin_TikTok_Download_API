const express = require('express');
const app = express();
const tmp = require('tmp'); // Import the tmp library
const cors = require('cors'); // Import the cors middleware
const { encrypt, decrypt } = require('./crypto'); // Assuming you have encrypt/decrypt functions in a crypto.js file
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const bodyParser = require('body-parser');

ffmpeg.setFfmpegPath('ffmpeg');

const BASE_URL = process.env.BASE_URL;
// Middleware to parse JSON bodies
app.use(
    cors({
      origin: '*', // Allow all origins (or specify specific origins)
      exposedHeaders: ['content-disposition', 'x-filename'], // Expose these headers
    })
);
app.use(express.json({
    limit: '10mb',
    strict: true,
    verify: (req, res, buf, encoding) => {
      try {
        JSON.parse(buf.toString());
      } catch (e) {
        console.error('Invalid JSON:', buf.toString());
        throw new Error('Invalid JSON');
      }
    }
}));

app.use(bodyParser.urlencoded({ extended: true }));

// POST endpoint at /tiktok
app.post('/tiktok', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    try {
        // Fetch data from localhost:3035/api/hybrid/video_data
        const response = await fetch(`http://127.0.0.1:3035/api/hybrid/video_data?url=${encodeURIComponent(url)}&minimal=true`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        // Generate JSON response
        const jsonResponse = generateJsonResponse(data, url);

        // Respond with the JSON content
        res.json(jsonResponse);
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).json({ error: 'Failed to fetch data from the external API' });
    }
});


// GET endpoint at /download
app.get('/download', async (req, res) => {
    const encryptedData = req.query.data;

    if (!encryptedData) {
        return res.status(400).json({ error: 'Encrypted data parameter is required' });
    }

    try {
        // Decrypt the data
        const decryptedData = decrypt(encryptedData, 'overflow');
        const { url, author, type } = JSON.parse(decryptedData); // Extract url, author, and type

        if (!url || !author || !type) {
            throw new Error('Invalid decrypted data: missing url, author, or type');
        }

        // Fetch the file from the decrypted URL
        const fileResponse = await fetch(url);

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
            contentType = 'image/jpeg'; // Default to JPEG for images
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
            'Content-Type': contentType
        });

        // Stream the file directly to the client
        const reader = fileResponse.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
        }
        res.end();
    } catch (error) {
        console.error('Error downloading file:', error);
        res.status(500).json({ error: 'Failed to download file' });
    }
});

function generateJsonResponse(data, url = '') {
    const videoData = data.data;
    const author = videoData.author;
    const statistics = videoData.statistics;
    const musicUrl = videoData.music.play_url.uri;
    const isImage = videoData.type === 'image';

    const filteredAuthor = {
        nickname: author.nickname,
        signature: author.signature,
        avatar: author.avatar_thumb?.url_list?.[0] || '' // Get first avatar URL
    };

    let picker = [];
    let audio = '';
    let audioFilename = '';
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
        // New metadata fields
        music_duration: videoData.music.duration, // Add music duration
        author: filteredAuthor// Include full author data
    };

    if (isImage) {
        const imageUrls = videoData.image_data;
        picker = imageUrls.no_watermark_image_list.map(url => ({
            type: 'photo',
            url: url
        }));

        const encryptedNoWatermarkUrls = imageUrls.no_watermark_image_list.map(url =>
            encrypt(JSON.stringify({ url, author: author.nickname, type: 'image' }), 'overflow', 360)
        );

        metadata.download_link.mp3 = `${BASE_URL}/download?data=${encrypt(JSON.stringify({url: musicUrl, author: author.nickname, type: 'mp3' }), 'overflow', 360)}`;

        metadata.download_link.no_watermark = encryptedNoWatermarkUrls.map(
            encryptedUrl => `${BASE_URL}/download?data=${encryptedUrl}`
        );
        metadata.download_slideshow_link = `${BASE_URL}/download-slideshow?url=${encrypt(url, 'overflow', 360)}`;
        
    } else {
        const videoUrls = videoData.video_data;

        // Function to encrypt and generate download link if URL is not null
        const generateDownloadLink = (url, author, type) => {
            if (url) {
                const encryptedUrl = encrypt(JSON.stringify({
                    url: url,
                    author: author.nickname,
                    type: type
                }), 'overflow', 360);
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

    audio = musicUrl;

    return {
        status: isImage ? 'picker' : 'tunnel', // Dynamic status based on type
        photos: picker,
        ...metadata
    };
}

async function downloadFile(url, outputPath) {
    const response = await axios({
      url,
      responseType: "stream",
    });
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
}
  
  
// Function to create slideshow video
// Function to create slideshow video with looping audio
async function createSlideshow(images, audioUrl, outputPath) {
    return new Promise((resolve, reject) => {
      const command = ffmpeg();
  
      // Add images with loop and duration
      images.forEach((image) => {
        command.input(image).inputOptions(['-loop 1', '-t 5']);
      });
  
      // Add audio input with loop option
      command.input(audioUrl).inputOptions(['-stream_loop -1']); // -1 means infinite loop
  
      // Build complex filter to scale/pad images and concatenate
      const filter = [];
      images.forEach((_, index) => {
        // Use a safer approach for scaling that won't cause padding errors
        filter.push(
          `[${index}:v]scale=w=1080:h=1920:force_original_aspect_ratio=decrease,` +
          `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${index}]`
        );
      });
  
      // Concatenate all scaled/padded video streams
      const concatInputs = images.map((_, i) => `[v${i}]`).join('');
      filter.push(`${concatInputs}concat=n=${images.length}:v=1:a=0[vout]`);
  
      // Calculate the total duration of the video
      const videoDuration = images.length * 5; // 5 seconds per image
  
      // Add audio filter to trim the looping audio to the video duration
      filter.push(`[${images.length}:a]atrim=0:${videoDuration}[aout]`);
  
      command
        .complexFilter(filter)
        .outputOptions([
          '-map', '[vout]',
          '-map', '[aout]', // Maps the processed audio
          '-pix_fmt', 'yuv420p',
          '-fps_mode', 'cfr'  // Modern replacement for -vsync 2
        ])
        .videoCodec('libx264')
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(err))
        .run();
    });
}
  
app.get("/download-slideshow", async (req, res) => {
    let { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: "URL parameter is required" });
    }

    // Decrypt the URL using the 'overflow' key
    try {
        url = decrypt(url, 'overflow');
    } catch (error) {
        return res.status(400).json({ error: "Failed to decrypt URL" });
    }

    try {
      // Fetch data from localhost:3035
      const response = await axios.get(
        `http://127.0.0.1:3035/api/hybrid/video_data?url=${encodeURIComponent(url)}&minimal=true`
      );
  
      const data = response.data.data;
  
      if (data.type !== "image") {
        return res.status(400).json({ error: "Only image posts are supported" });
      }
  
      // Create a unique temporary directory for files
      const tmpDir = tmp.dirSync({ unsafeCleanup: true }); // Automatically clean up files
      const tmpDirPath = tmpDir.name;
  
      // Download images
      const imageUrls = data.image_data.no_watermark_image_list;
      const imagePaths = [];
      for (let i = 0; i < imageUrls.length; i++) {
        const imagePath = path.join(tmpDirPath, `image_${i}.jpg`);
        await downloadFile(imageUrls[i], imagePath);
        imagePaths.push(imagePath);
      }
  
      // Download audio
      const audioUrl = data.music.play_url.url_list[0];
      const audioPath = path.join(tmpDirPath, "audio.mp3");
      await downloadFile(audioUrl, audioPath);
  
      // Create slideshow video
      const outputPath = path.join(tmpDirPath, "slideshow.mp4");
      await createSlideshow(imagePaths, audioPath, outputPath);
  
      // Generate a unique download filename using the author's nickname
      const authorNickname = data.author.nickname.replace(/[^a-zA-Z0-9]/g, '_'); // Sanitize nickname
      const uniqueFilename = `${authorNickname}_${Date.now()}.mp4`;
  
      // Return the video file
      res.download(outputPath, uniqueFilename, (err) => {
        if (err) {
          console.error("Error sending file:", err);
          res.status(500).json({ error: "Failed to send video file" });
        }
  
        // Clean up the temporary directory and files
        tmpDir.removeCallback(); // Automatically deletes the directory and its contents
      });
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Failed to create slideshow" });
    }
});

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
const PORT = 3039;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});