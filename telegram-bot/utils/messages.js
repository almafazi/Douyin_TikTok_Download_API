import { escapeMarkdown } from './helpers.js';

export const messages = {
  welcome: (username) => `
🎬 *Selamat Datang di TikTok Downloader Bot!*

Halo ${escapeMarkdown(username)}! 👋

Kirimkan link TikTok untuk:
• 📹 Download video tanpa watermark
• 🎵 Download audio MP3
• 🖼️ Download slideshow/foto
• 🎬 Konversi slideshow ke video

*Cara penggunaan:*
1. Copy link TikTok
2. Paste di chat ini
3. Pilih format yang diinginkan

*Support:*
• Video TikTok (HD/SD)
• Slideshow/Foto
• Audio/MP3

Ketik /help untuk bantuan lebih lanjut.
  `,

  help: () => `
📖 *Panduan Penggunaan*

*Perintah:*
/start - Memulai bot
/help - Menampilkan bantuan
/stats - Cek status API

*Cara Download:*
1. Buka TikTok app
2. Tap "Share" pada video
3. Pilih "Copy Link"
4. Paste link di chat ini
5. Pilih format download

*Format yang didukung:*
• Video tanpa watermark (HD/SD)
• Video dengan watermark
• Audio MP3
• Slideshow (foto/video)

*Tips:*
• Gunakan HD untuk kualitas terbaik
• Audio MP3 untuk ringtone
• Slideshow video untuk story

Jika mengalami masalah, coba lagi beberapa saat.
  `,

  processing: () => `
⏳ *Sedang memproses...*

Mengambil informasi video dari TikTok...
  `,

  downloading: (type) => {
    const typeEmoji = type === 'mp3' ? '🎵' : '📹';
    return `${typeEmoji} *Sedang mengunduh...*\n\nMohon tunggu, file sedang diproses...`;
  },

  creatingSlideshow: () => `
🎬 *Sedang membuat slideshow...*

Menggabungkan foto dan audio...
Ini membutuhkan waktu beberapa saat.
  `,

  videoInfo: ({ author, title, duration, views, likes, comments, shares }) => `
🎬 *Video TikTok*

👤 *Author:* ${escapeMarkdown(author)}
📝 *Title:* ${escapeMarkdown(title)}
⏱️ *Duration:* ${duration}

📊 *Statistics:*
👁️ ${views} views
❤️ ${likes} likes
💬 ${comments} comments
🔄 ${shares} shares

Pilih format download:
  `,

  slideshowInfo: ({ author, title, photoCount, views, likes, comments }) => `
🖼️ *Slideshow TikTok*

👤 *Author:* ${escapeMarkdown(author)}
📝 *Title:* ${escapeMarkdown(title)}
📷 *Photos:* ${photoCount} images

📊 *Statistics:*
👁️ ${views} views
❤️ ${likes} likes
💬 ${comments} comments

Pilih format download:
  `,

  downloadComplete: () => `
✅ *Download selesai!*

File berhasil diunduh dan dikirim.
  `,

  slideshowComplete: () => `
✅ *Slideshow selesai!*

Video slideshow berhasil dibuat.
  `,

  fileTooBig: (size) => `
⚠️ *File terlalu besar!*

Ukuran file: ${size}
Batas maksimal: 50MB

Silakan download manual menggunakan link yang diberikan.
  `,

  invalidUrl: () => `
❌ *Link tidak valid!*

Pastikan kamu mengirim link TikTok yang benar.

Contoh link yang valid:
• https://tiktok.com/@username/video/123456
• https://vm.tiktok.com/AbCdEfG

Cara mendapatkan link:
1. Buka video TikTok
2. Tap tombol "Share"
3. Pilih "Copy Link"
  `,

  error: (message) => `
❌ *Terjadi kesalahan!*

${escapeMarkdown(message || 'Silakan coba lagi beberapa saat.')}

Jika masalah berlanjut, ketik /stats untuk cek status API.
  `,

  stats: (health) => {
    const statusEmoji = health.status === 'ok' ? '✅' : '❌';
    const primaryEmoji = health.apis?.primary === 'online' ? '🟢' : '🔴';
    const fallbackEmoji = health.apis?.fallback === 'online' ? '🟢' : '🔴';

    return `
📊 *Status API*

${statusEmoji} *Status:* ${health.status.toUpperCase()}
🕐 *Time:* ${health.time}

*API Services:*
${primaryEmoji} Primary API: ${health.apis?.primary || 'unknown'}
${fallbackEmoji} Fallback API: ${health.apis?.fallback || 'unknown'}

Jika API offline, coba lagi nanti.
    `;
  }
};
