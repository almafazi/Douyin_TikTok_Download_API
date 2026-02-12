# TikTok Downloader Telegram Bot

Bot Telegram untuk download video TikTok tanpa watermark, audio MP3, dan slideshow.

## Features

- 📹 Download video TikTok tanpa watermark (HD/SD)
- 🎵 Download audio MP3
- 🖼️ Download slideshow/foto
- 🎬 Konversi slideshow ke video MP4
- 📊 Info lengkap video (views, likes, comments)
- ⚡ Progress indicator
- 🔄 Fallback otomatis

## Prerequisites

- Node.js 18+
- API TikTok Downloader berjalan di port 6068
- Bot Token dari [@BotFather](https://t.me/botfather)

## Installation

1. Clone repository:
```bash
cd telegram-bot
```

2. Install dependencies:
```bash
npm install
```

3. Copy environment file:
```bash
cp .env.example .env
```

4. Edit `.env` dan isi:
```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
API_BASE_URL=http://localhost:6068
```

5. Jalankan bot:
```bash
npm start
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Memulai bot |
| `/help` | Panduan penggunaan |
| `/stats` | Cek status API |

## Usage

1. Copy link TikTok
2. Paste di chat bot
3. Pilih format download dari menu

## Docker

Build image:
```bash
docker build -t tiktok-telegram-bot .
```

Run container:
```bash
docker run -d \
  --name telegram-bot \
  --env-file .env \
  --network host \
  tiktok-telegram-bot
```

## Project Structure

```
telegram-bot/
├── bot.js              # Main bot logic
├── utils/
│   ├── helpers.js      # Helper functions
│   ├── logger.js       # Logger config
│   └── messages.js     # Bot messages
├── package.json
├── Dockerfile
├── .env.example
└── README.md
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | - | Token dari BotFather |
| `API_BASE_URL` | No | http://localhost:6068 | URL API downloader |
| `MAX_FILE_SIZE` | No | 52428800 | Batas ukuran file (bytes) |
| `LOG_LEVEL` | No | info | Level logging |

## License

MIT
