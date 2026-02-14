# TikTok Downloader Telegram Bot

Bot Telegram untuk download video TikTok tanpa watermark, audio MP3, dan slideshow. Dilengkapi dengan Analytics Dashboard lengkap.

## Features

- 📹 Download video TikTok tanpa watermark (HD/SD)
- 🎵 Download audio MP3
- 🖼️ Download slideshow/foto
- 🎬 Konversi slideshow ke video MP4
- 📊 Info lengkap video (views, likes, comments)
- ⚡ Progress indicator
- 🔄 Fallback otomatis
- 📈 **Analytics Dashboard** - Track penggunaan bot real-time

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
| `/adminstats` | Analytics summary (admin only) |

## Analytics Dashboard

Bot dilengkapi dengan dashboard analytics lengkap yang dapat diakses di:
- **URL**: `http://your-server:3001`
- **Features**:
  - 📊 Statistik real-time (Total Users, Active Users, Downloads, Success Rate)
  - 📈 Grafik downloads trend (24h, 7d, 30d)
  - 🥧 Breakdown content type (Video, Audio, Slideshow, Photo)
  - 📊 Command usage statistics
  - 👑 Top users leaderboard
  - 🚨 Recent errors log
  - ⏱️ Auto-refresh setiap 30 detik

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
├── bot.js                      # Main bot logic
├── server.js                   # Express server
├── analytics/
│   ├── connection.js           # MongoDB connection
│   ├── models/
│   │   ├── User.js             # User tracking schema
│   │   ├── Download.js         # Download events schema
│   │   ├── Command.js          # Command usage schema
│   │   └── Error.js            # Error tracking schema
│   ├── services/
│   │   └── analyticsService.js # Analytics tracking service
│   └── dashboard/
│       ├── server.js           # Dashboard Express server
│       ├── routes/
│       │   └── api.js          # Dashboard API endpoints
│       └── public/
│           ├── index.html      # Dashboard UI
│           ├── style.css       # Dashboard styling
│           └── app.js          # Dashboard logic & charts
├── utils/
│   ├── helpers.js              # Helper functions
│   ├── logger.js               # Logger config
│   ├── messages.js             # Bot messages
│   ├── redis.js                # Redis connection
│   ├── rateLimiter.js          # Rate limiting
│   ├── axiosConfig.js          # Axios configuration
│   ├── errorHandler.js         # Error handling
│   └── keyboard.js             # Bot keyboards
├── docker-compose.yml
├── Dockerfile
├── package.json
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
| `MONGO_ROOT_PASSWORD` | Yes* | changeme | Password MongoDB root user |
| `MONGODB_URI` | Yes* | - | MongoDB connection string |
| `ANALYTICS_ENABLED` | No | true | Enable/disable analytics |
| `ADMIN_USER_ID` | Yes* | - | Telegram user ID admin |
| `DASHBOARD_PORT` | No | 3001 | Port untuk analytics dashboard |
| `DASHBOARD_PUBLIC` | No | true | Dashboard access public/private |

*Required untuk analytics features

## License

MIT
