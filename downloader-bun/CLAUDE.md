# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Basic Operations
- **Install dependencies**: `bun install`
- **Run server**: `bun run index.js` (starts on port 3021 by default)
- **Cleanup temp files**: `node cleanup.js` (manual cleanup)

### Testing
- **Quick test**: `node test/quick-test.js`

### Docker Operations
- **Build image**: `docker build -t tiktok-downloader .`
- **Run with docker-compose**: `docker-compose up -d`
- **Default Docker port**: 6068

## Architecture Overview

### Core Application Structure
This is a Node.js Express server that provides TikTok/Douyin video and image downloading services with a dual-API architecture for reliability.

**Main Components:**
- `index.js` - Express server with API endpoints and main application logic
- `tiktok-library.js` - Primary TikTok API client using @tobyg74/tiktok-api-dl
- `tiktok-fallback.js` - Fallback API client using tikwm.com workers
- `encryption.js` - AES-GCM encryption/decryption for secure download links
- `cleanup.js` - Automated temp file cleanup with cron scheduling

### API Architecture
The application uses a **primary-fallback pattern** for reliability:
1. **Primary API**: External Douyin API service (`DOUYIN_API_URL`)
2. **Secondary API**: @tobyg74/tiktok-api-dl library with cookies
3. **Fallback API**: tikwm.com via workers (tiktok.apigugel3.workers.dev)

### Content Processing Pipeline
1. **URL Processing** → **API Selection** → **Data Normalization** → **Encryption** → **Download/Stream**
2. Supports both video and image slideshow content types
3. Uses FFmpeg for slideshow creation from images + audio
4. Implements streaming downloads for large files

### Security & Storage
- **Encryption**: All download links use AES-GCM encryption with TTL
- **Temp Management**: Automatic cleanup every 15 minutes via cron
- **File Streaming**: Direct stream-to-response to minimize server storage
- **Result Caching**: In-memory cache stores unencrypted URLs, generates fresh encrypted links on each request

## Environment Configuration

Required environment variables (with defaults):
```
PORT=3021
BASE_URL=http://localhost:3021
ENCRYPTION_KEY=overflow
DOUYIN_API_URL=http://127.0.0.1:3035/api/hybrid/video_data
CACHE_TTL=3600
```

## API Endpoints

### Core Endpoints
- `POST /tiktok` - Process TikTok URL and return metadata with download links
- `GET /download?data=<encrypted>` - Download individual files (video/audio/image)
- `GET /download-slideshow?url=<encrypted>` - Generate and download slideshow from images
- `GET /health` - Health check showing API status

### Response Format
The application normalizes all API responses to a consistent format with encrypted download links, supporting both `tunnel` (video) and `picker` (image) status types.

## Development Notes

### FFmpeg Integration
- Uses ffmpeg-static for slideshow generation
- Creates 1080x1920 videos from image sequences with audio
- Each image displays for 4 seconds in slideshows

### Cookie Management
The primary TikTok library uses hardcoded cookies for authentication. Update cookies in `index.js:600` when they expire.

### Proxy Configuration
Proxy support is commented out but available in fallback downloader. Uncomment proxy lines in `tiktok-fallback.js` if needed.

### Caching System
- **Cache Storage**: In-memory Map with TTL-based expiration (default: 1 hour)
- **Cache Key**: Normalized TikTok URLs (removes mobile/vm domains, query params)
- **Cache Content**: Unencrypted URLs and metadata, encrypted fresh on each request
- **Cache Cleanup**: Automatic cleanup every 10 minutes removes expired entries
- **Cache Stats**: Available via `/health` endpoint