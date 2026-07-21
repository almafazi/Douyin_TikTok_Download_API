import { escapeMarkdown } from './helpers.js';

export const messages = {
  welcome: (username) => `
🎬 *Welcome to TikTok Downloader Bot!*

Hello ${escapeMarkdown(username)}! 👋

Send a TikTok link to:
• 📹 Download TikTok videos without watermark
• 🎵 Convert TikTok to MP3 audio
• 🖼️ Download TikTok slideshow/photos
• 🎬 Convert TikTok slideshow to video

*How to use:*
1. Copy a TikTok link
2. Paste it in this chat
3. Watch a short ad
4. Choose your preferred format

*Support:*
• TikTok / Douyin video (HD/SD)
• Slideshow/Photo
• Audio/MP3

Type /help for more details.
  `,

  help: () => `
📖 *User Guide*

*Commands:*
/start - Start the bot
/help - Show help
/stats - Check API status

*How to download:*
1. Open the TikTok or Douyin app
2. Tap "Share" on a video
3. Choose "Copy Link"
4. Paste the link in this chat
5. Watch a short ad
6. Pick a download format

*Supported formats:*
• Video without watermark (HD/SD)
• Video with watermark
• Audio MP3
• Slideshow (photo/video)

*Tips:*
• Use HD for the best quality
• Use MP3 audio for ringtones
• Use slideshow video for stories

If you have issues, please try again in a few moments.
  `,

  processing: () => `
⏳ *Processing...*

Fetching video details...
  `,

  readyToDownload: () => `
✅ *Ready to download!*

Choose an option from the media card below.
  `,

  downloading: (type) => {
    const typeEmoji = type === 'mp3' ? '🎵' : '📹';
    return `${typeEmoji} *Downloading...*\n\nPlease wait, your file is being processed...`;
  },

  uploading: (type) => {
    const typeEmoji = type === 'mp3' ? '🎵' : '📹';
    const label = type === 'mp3' ? 'MP3 audio' : 'video';
    return `${typeEmoji} *Uploading...*\n\nSending your ${label} to Telegram...`;
  },

  creatingSlideshow: () => `
🎬 *Creating slideshow...*

Merging photos and audio...
This may take a little time.
  `,

  slideshowQueued: () => `
🎬 *Slideshow is being processed...*

Your slideshow video is being created in the background.
This may take 2-3 minutes depending on the number of photos.

⏳ Please wait, the video will be sent automatically when ready.
  `,

  videoInfo: ({ author, title, duration, views, likes, comments, shares }) => `
🎬 *TikTok Video*

👤 *Author:* ${escapeMarkdown(author)}
📝 *Title:* ${escapeMarkdown(title)}
⏱️ *Duration:* ${duration}

📊 *Statistics:*
👁️ ${views} views
❤️ ${likes} likes
💬 ${comments} comments
🔄 ${shares} shares

Choose a download format:
  `,

  slideshowInfo: ({ author, title, photoCount, views, likes, comments }) => `
🖼️ *TikTok Slideshow*

👤 *Author:* ${escapeMarkdown(author)}
📝 *Title:* ${escapeMarkdown(title)}
📷 *Photos:* ${photoCount} images

📊 *Statistics:*
👁️ ${views} views
❤️ ${likes} likes
💬 ${comments} comments

Choose a download format:
  `,

  downloadComplete: () => `
✅ *Download complete!*

Your file was downloaded and sent successfully.
  `,

  slideshowComplete: () => `
✅ *Slideshow complete!*

Your slideshow video was created successfully.
  `,

  fileTooBig: (size, url) => `
⚠️ File is too large!

File size: ${size}
Maximum limit: 50MB

Please download it manually using this link:
${url}
  `,

  invalidUrl: () => `
❌ *Invalid link!*

Please make sure you send a valid TikTok or Douyin link.

Examples of valid links:
• https://tiktok.com/@username/video/123456
• https://vm.tiktok.com/AbCdEfG
• https://www.douyin.com/video/123456

How to get the link:
1. Open a TikTok or Douyin video
2. Tap the "Share" button
3. Select "Copy Link"
  `,

  error: (message) => `
❌ *An error occurred!*

${escapeMarkdown(message || 'Please try again in a few moments.')}

If the problem continues, type /stats to check API status.
  `,

  stats: (health) => {
    const statusEmoji = health.status === 'ok' ? '✅' : '❌';
    const hosts = Array.isArray(health.hosts) ? health.hosts : [];
    const hostLines = hosts.length > 0
      ? hosts.map((host) => {
        const emoji = host.status === 'online' ? '🟢' : host.status === 'degraded' ? '🟡' : '🔴';
        const label = host.kind === 'douyin' ? 'Douyin' : 'TikTok';
        const latency = typeof host.ms === 'number' ? ` (${host.ms}ms)` : '';
        return `${emoji} ${label}: ${host.base} — ${host.status}${latency}`;
      }).join('\n')
      : 'No hosts configured';

    const keyLine = health.apiKeyConfigured === false
      ? '\n⚠️ *API key not configured*'
      : '';

    return `
📊 *API Status*

${statusEmoji} *Status:* ${(health.status || 'unknown').toUpperCase()}
🕐 *Time:* ${health.time || '-'}
${keyLine}

*API Hosts:*
${hostLines}

If all hosts are offline, please try again later.
    `;
  }
};
