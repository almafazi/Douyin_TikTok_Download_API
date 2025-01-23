const express = require('express');
const app = express();
const cors = require('cors'); // Import the cors middleware
const { encrypt, decrypt } = require('./crypto'); // Assuming you have encrypt/decrypt functions in a crypto.js file

const BASE_URL = process.env.BASE_URL;
// Middleware to parse JSON bodies
app.use(cors());

app.use(express.json());

// POST endpoint at /tiktok
app.post('/tiktok', async (req, res) => {
    const url = req.body.url;

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

        res.json(data);
        // Parse the response into the HTML template
        // const htmlContent = generateHtml(data, url);

        // // Respond with the HTML content
        // res.json({ html: htmlContent });
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
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', contentType);

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

// Function to generate HTML from the JSON response
function generateHtml(data, url = '') {
    const videoData = data.data;
    const author = videoData.author;
    const statistics = videoData.statistics;

    const musicUrl = videoData.music.play_url.uri;
    // Check if the data type is image
    const isImage = videoData.type === 'image';

    let html = '';

    if (isImage) {
        // Generate HTML for image data
        const imageUrls = videoData.image_data;

        // Encrypt the download data for each image
        const encryptedNoWatermarkUrls = imageUrls.no_watermark_image_list.map(url =>
            encrypt(JSON.stringify({ url, author: author.nickname, type: 'image' }), 'overflow', 360)
        );
        const encryptedWatermarkUrls = imageUrls.watermark_image_list.map(url =>
            encrypt(JSON.stringify({ url, author: author.nickname, type: 'image' }), 'overflow', 360)
        );

        const encryptedMp3Url = encrypt(JSON.stringify({
            url: musicUrl,
            author: author.nickname,
            type: 'mp3'
        }), 'overflow', 360);

        html = `
        <div class="container" data-id="Image">
            <div class="row download-box">
                <!-- Left Column: User Info and Actions -->
                <div class="col-12 col-md-6">
                    <div class="down-left">
                        <!-- User Avatar -->
                        <div class="user-avatar">
                            <img src="${videoData.cover_data?.cover?.url_list[0]}" alt="thumbnail" id="thumbnail">
                        </div>
                        <!-- User Info -->
                        <div class="user-info">
                            <div class="user-fullname">${author.nickname}</div>
                            <div class="user-username">@${videoData.desc}</div>
                            <div class="user-username">
                                <i class="ph ph-repeat"></i><span class="me-2">${statistics.repost_count}</span>
                                <i class="ph ph-chat-circle-dots"></i><span class="me-2">${statistics.comment_count}</span>
                                <i class="ph ph-heart"></i><span class="me-2">${statistics.digg_count}</span>
                                <i class="ph ph-play"></i><span class="me-2">${statistics.play_count}</span>
                            </div>
                        </div>
                    </div>
                    <!-- Download Another Button -->
                    <a href="/" class="btn btn-main btn-back btn-backpc">
                        <svg width="20" height="21" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <g clip-path="url(#a)">
                                <path d="M14.708 6.286A6.631 6.631 0 0 0 10 4.328a6.658 6.658 0 0 0-6.658 6.666A6.658 6.658 0 0 0 10 17.661c3.108 0 5.7-2.125 6.442-5h-1.734A4.992 4.992 0 0 1 10 15.994c-2.758 0-5-2.241-5-5 0-2.758 2.242-5 5-5a4.93 4.93 0 0 1 3.517 1.484l-2.684 2.683h5.834V4.328l-1.959 1.958Z" fill="#fff"></path>
                            </g>
                            <defs>
                                <clipPath id="a">
                                    <path fill="#fff" transform="translate(0 .994)" d="M0 0h20v20H0z"></path>
                                </clipPath>
                            </defs>
                        </svg>
                        Download another
                    </a>
                </div>
                <!-- Right Column: Download Options -->
                <div class="col-12 col-md-4 offset-md-2">
                    <div class="down-right">
                        <!-- Download Buttons -->
                        <a target="_blank" href="https://tiktok.y2mate.one/?url=${url}" class="btn btn-main active mb-2" rel="nofollow">Download Video</a>
                        <a href="${BASE_URL}/download?data=${encryptedMp3Url}" class="btn btn-main active mb-2" rel="nofollow">MP3 Download</a>
                        <!-- Download Another Button -->
                        <a href="/" class="btn btn-main btn-back">
                            <svg width="20" height="21" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <g clip-path="url(#a)">
                                    <path d="M14.708 6.286A6.631 6.631 0 0 0 10 4.328a6.658 6.658 0 0 0-6.658 6.666A6.658 6.658 0 0 0 10 17.661c3.108 0 5.7-2.125 6.442-5h-1.734A4.992 4.992 0 0 1 10 15.994c-2.758 0-5-2.241-5-5 0-2.758 2.242-5 5-5a4.93 4.93 0 0 1 3.517 1.484l-2.684 2.683h5.834V4.328l-1.959 1.958Z" fill="#fff"></path>
                                </g>
                                <defs>
                                    <clipPath id="a">
                                        <path fill="#fff" transform="translate(0 .994)" d="M0 0h20v20H0z"></path>
                                    </clipPath>
                                </defs>
                            </svg>
                            Download other
                        </a>
                    </div>
                </div>
            </div>
            <!-- Image Slides Section -->
            <div class="tt-slide">
                ${imageUrls.no_watermark_image_list.map((url, index) => `
                    <div>
                        <div>
                            <img alt="" src="${url}">
                            <div>
                                <a class="btn btn-main" href="${BASE_URL}/download?data=${encryptedNoWatermarkUrls[index]}">Download Image ${index + 1}</a>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
        `;
    } else {
        // Generate HTML for video data (existing logic)
        const videoUrls = videoData.video_data;
        const musicUrl = videoData.music.play_url.uri;

        // Encrypt the download data
        const encryptedWmUrl = encrypt(JSON.stringify({
            url: videoUrls.wm_video_url,
            author: author.nickname,
            type: 'video'
        }), 'overflow', 360);

        const encryptedWmHqUrl = encrypt(JSON.stringify({
            url: videoUrls.wm_video_url_HQ,
            author: author.nickname,
            type: 'video'
        }), 'overflow', 360);

        const encryptedNwmUrl = encrypt(JSON.stringify({
            url: videoUrls.nwm_video_url,
            author: author.nickname,
            type: 'video'
        }), 'overflow', 360);

        const encryptedNwmHqUrl = encrypt(JSON.stringify({
            url: videoUrls.nwm_video_url_HQ,
            author: author.nickname,
            type: 'video'
        }), 'overflow', 360);

        const encryptedMp3Url = encrypt(JSON.stringify({
            url: musicUrl,
            author: author.nickname,
            type: 'mp3'
        }), 'overflow', 360);

        html = `
        <div class="container" data-id="Video">
            <div class="row download-box">
                <!-- Left Column: User Info and Actions -->
                <div class="col-12 col-md-6">
                    <div class="down-left">
                        <!-- User Avatar -->
                        <div class="user-avatar">
                            <img src="${author.avatar_thumb.url_list[0]}" alt="thumbnail" id="thumbnail">
                        </div>
                        <!-- User Info -->
                        <div class="user-info">
                            <div class="user-fullname">${author.nickname}</div>
                            <div class="user-username">@${author.unique_id}</div>
                            <div class="user-username">
                                <i class="ph ph-repeat"></i><span class="me-2">${statistics.repost_count}</span>
                                <i class="ph ph-chat-circle-dots"></i><span class="me-2">${statistics.comment_count}</span>
                                <i class="ph ph-heart"></i><span class="me-2">${statistics.digg_count}</span>
                                <i class="ph ph-play"></i><span class="me-2">${statistics.play_count}</span>
                            </div>
                        </div>
                    </div>
                    <!-- Download Another Button -->
                    <a href="/" class="btn btn-main btn-back btn-backpc">
                        <svg width="20" height="21" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <g clip-path="url(#a)">
                                <path d="M14.708 6.286A6.631 6.631 0 0 0 10 4.328a6.658 6.658 0 0 0-6.658 6.666A6.658 6.658 0 0 0 10 17.661c3.108 0 5.7-2.125 6.442-5h-1.734A4.992 4.992 0 0 1 10 15.994c-2.758 0-5-2.241-5-5 0-2.758 2.242-5 5-5a4.93 4.93 0 0 1 3.517 1.484l-2.684 2.683h5.834V4.328l-1.959 1.958Z" fill="#fff"></path>
                            </g>
                            <defs>
                                <clipPath id="a">
                                    <path fill="#fff" transform="translate(0 .994)" d="M0 0h20v20H0z"></path>
                                </clipPath>
                            </defs>
                        </svg>
                        Download another
                    </a>
                </div>
                <!-- Right Column: Download Options -->
                <div class="col-12 col-md-4 offset-md-2">
                    <div class="down-right">
                        <!-- Download Buttons -->
                        <a href="${BASE_URL}/download?data=${encryptedWmUrl}" class="btn btn-main active mb-2" rel="nofollow">Download</a>
                        <a href="${BASE_URL}/download?data=${encryptedWmHqUrl}" class="btn btn-main active mb-2" rel="nofollow">Download HD</a>
                        <a href="${BASE_URL}/download?data=${encryptedNwmUrl}" class="btn btn-main active mb-2" rel="nofollow">Download No Watermark</a>
                        <a href="${BASE_URL}/download?data=${encryptedNwmHqUrl}" class="btn btn-main active mb-2" rel="nofollow">Download No Watermark HD</a>
                        <!-- MP3 Download Button -->
                        <a href="${BASE_URL}/download?data=${encryptedMp3Url}" class="btn btn-main active mb-2" rel="nofollow">MP3 Download</a>
                        <!-- Download Another Button -->
                        <a href="/" class="btn btn-main btn-back">
                            <svg width="20" height="21" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <g clip-path="url(#a)">
                                    <path d="M14.708 6.286A6.631 6.631 0 0 0 10 4.328a6.658 6.658 0 0 0-6.658 6.666A6.658 6.658 0 0 0 10 17.661c3.108 0 5.7-2.125 6.442-5h-1.734A4.992 4.992 0 0 1 10 15.994c-2.758 0-5-2.241-5-5 0-2.758 2.242-5 5-5a4.93 4.93 0 0 1 3.517 1.484l-2.684 2.683h5.834V4.328l-1.959 1.958Z" fill="#fff"></path>
                                </g>
                                <defs>
                                    <clipPath id="a">
                                        <path fill="#fff" transform="translate(0 .994)" d="M0 0h20v20H0z"></path>
                                    </clipPath>
                                </defs>
                            </svg>
                            Download other video
                        </a>
                    </div>
                </div>
            </div>
        </div>
        `;
    }

    return html;
}

// Start the server
const PORT = 3036;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});