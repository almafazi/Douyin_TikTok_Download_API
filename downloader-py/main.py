import os
import json
import time
import shutil
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, Dict, Any, List
import httpx
import asyncio
import uvicorn
import uvloop  # Added uvloop for better performance
import uuid
from urllib.parse import quote

from fastapi.responses import StreamingResponse
from fastapi import FastAPI, HTTPException, BackgroundTasks, Response
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware  # Added for response compression

from crypto import encrypt, decrypt

# Constants
BASE_URL = os.getenv("BASE_URL", "https://d.snaptik.fit")  # From .env file
ENCRYPTION_KEY = os.getenv("ENCRYPTION_KEY", "overflow")  # Changed to use env var with fallback
TEMP_DIR = os.path.join(os.getcwd(), "temp")
HYBRID_API_URL = os.getenv("DOUYIN_API_URL", "http://douyin_tiktok_download_api:8000/api/hybrid/video_data")

# Create temp directory if it doesn't exist
os.makedirs(TEMP_DIR, exist_ok=True)

# Storage for file timestamps - for smarter temp file management
file_timestamps = {}

# Models
class TikTokRequest(BaseModel):
    url: str

class DownloadQueryParams(BaseModel):
    data: str

app = FastAPI(title="TikTok Downloader API")

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["content-disposition", "x-filename"],
)

# Add compression middleware (Optimization 4: Response Compression)
app.add_middleware(GZipMiddleware, minimum_size=1000)

# Background task to remove expired temp files
# Optimization 5: Smarter Temp File Management
async def cleanup_temp_files():
    """Remove temporary files and folders older than 1 hour with improved tracking"""
    try:
        current_time = datetime.now()
        expired_items = []
        
        # First pass: identify expired items
        for item in os.listdir(TEMP_DIR):
            item_path = os.path.join(TEMP_DIR, item)
            if os.path.isdir(item_path):
                # Check if we have a timestamp recorded
                if item_path in file_timestamps:
                    timestamp = file_timestamps[item_path]
                else:
                    # Get folder modification time if no timestamp recorded
                    timestamp = datetime.fromtimestamp(os.path.getmtime(item_path))
                    file_timestamps[item_path] = timestamp
                
                # If older than 1 hour, mark for removal
                if current_time - timestamp > timedelta(hours=1):
                    expired_items.append(item_path)
        
        # Second pass: remove expired items
        for item_path in expired_items:
            try:
                shutil.rmtree(item_path)
                # Remove from timestamps dictionary
                if item_path in file_timestamps:
                    del file_timestamps[item_path]
                print(f"Removed old temp directory: {item_path}")
            except Exception as e:
                print(f"Error removing directory {item_path}: {e}")
    except Exception as e:
        print(f"Error in cleanup task: {e}")

# Scheduled task for cleaning up temp files
@app.on_event("startup")
async def start_scheduler():
    asyncio.create_task(run_cleanup_scheduler())

async def run_cleanup_scheduler():
    while True:
        await cleanup_temp_files()
        # Run every 30 minutes
        await asyncio.sleep(30 * 60)

def get_nested_value(data, keys, default=None):
    """
    Safely get nested dictionary values with fallback
    
    Args:
        data (dict): The dictionary to extract from
        keys (list): List of keys to traverse
        default: Default value if any key is missing
        
    Returns:
        The value or default if not found
    """
    result = data
    for key in keys:
        if not isinstance(result, dict):
            return default
        result = result.get(key, default)
        if result is None:
            return default
    return result


def get_first_from_nested_list(data, keys, default=''):
    """
    Safely get the first item from a nested list within a dictionary
    
    Args:
        data (dict): The dictionary to extract from
        keys (list): List of keys to traverse
        default: Default value if any key is missing or list is empty
        
    Returns:
        The first list item or default if not found
    """
    nested_list = get_nested_value(data, keys, [])
    return nested_list[0] if nested_list else default


def generate_encrypted_download_link(url, author_nickname, media_type, encryption_key, base_url, expiry=360):
    """
    Generate encrypted download link
    
    Args:
        url (str): The source URL
        author_nickname (str): Content creator's nickname
        media_type (str): Type of media (video, image, mp3)
        encryption_key (str): The encryption key
        base_url (str): Base URL for the download endpoint
        expiry (int): Expiry time in seconds
        
    Returns:
        str: Generated download link or None if error
    """
    if not url:
        return None
    
    try:
        encrypted_url = encrypt(
            json.dumps({
                "url": url,
                "author": author_nickname,
                "type": media_type
            }),
            encryption_key,
            expiry
        )
        return f"{base_url}/download?data={encrypted_url}"
    except Exception as e:
        print(f"Error generating download link for {media_type}: {e}")
        return None


def generate_json_response(data: Dict[str, Any], url: str = '') -> Dict[str, Any]:
    """
    Generate JSON response with video/image metadata
    
    Args:
        data (dict): The data from TikTok API
        url (str): Original TikTok URL
        
    Returns:
        dict: Formatted response with metadata and download links
    """
    try:
        video_data = data.get("data", {})
        
        # Check content type
        is_image = video_data.get("type") == "image"
        
        # Extract author data
        author = video_data.get("author", {})
        author_nickname = author.get("nickname", "Unknown")
        
        # Build author metadata
        filtered_author = {
            "nickname": author_nickname,
            "signature": author.get("signature", ""),
            "avatar": get_first_from_nested_list(author, ["avatar_thumb", "url_list"])
        }
        
        # Extract statistics
        statistics = video_data.get("statistics", {})
        stats_metadata = {
            "repost_count": statistics.get("repost_count", 0),
            "comment_count": statistics.get("comment_count", 0),
            "digg_count": statistics.get("digg_count", 0),
            "play_count": statistics.get("play_count", 0)
        }
        
        # Extract music data
        music = video_data.get("music", {})
        music_url = get_nested_value(music, ["play_url", "uri"], 
                    get_nested_value(music, ["play_url", "url"], ""))
        
        # Basic metadata common to both image and video
        metadata = {
            "title": video_data.get("desc", ""),
            "description": video_data.get("desc", ""),
            "statistics": stats_metadata,
            "artist": author_nickname,
            "cover": get_first_from_nested_list(video_data, ["cover_data", "cover", "url_list"]),
            "duration": video_data.get("duration", 0),
            "audio": music_url,
            "music_duration": music.get("duration", 0),
            "author": filtered_author,
            "download_link": {}
        }
        
        # Process MP3 download link (common to both types)
        mp3_link = generate_encrypted_download_link(
            music_url, author_nickname, "mp3", ENCRYPTION_KEY, BASE_URL
        )
        if mp3_link:
            metadata["download_link"]["mp3"] = mp3_link
        
        # Image-specific processing
        if is_image:
            # Get image list
            image_data = video_data.get("image_data", {})
            no_watermark_images = image_data.get("no_watermark_image_list", [])
            
            # Create picker for image gallery
            picker = [
                {"type": "photo", "url": img_url}
                for img_url in no_watermark_images
            ]
            
            # Generate image download links
            encrypted_image_links = []
            for img_url in no_watermark_images:
                link = generate_encrypted_download_link(
                    img_url, author_nickname, "image", ENCRYPTION_KEY, BASE_URL
                )
                if link:
                    encrypted_image_links.append(link)
            
            if encrypted_image_links:
                metadata["download_link"]["no_watermark"] = encrypted_image_links
            
            # Add slideshow download link
            try:
                metadata["download_slideshow_link"] = f"{BASE_URL}/download-slideshow?url={encrypt(url, ENCRYPTION_KEY, 360)}"
            except Exception as e:
                print(f"Error generating slideshow link: {e}")
            
            return {
                "status": "picker",
                "photos": picker,
                **metadata
            }
            
        # Video-specific processing
        else:
            video_urls = video_data.get("video_data", {})
            
            # Generate all video download links
            download_links = {
                "watermark": generate_encrypted_download_link(
                    video_urls.get("wm_video_url"), author_nickname, "video", ENCRYPTION_KEY, BASE_URL
                ),
                "watermark_hd": generate_encrypted_download_link(
                    video_urls.get("wm_video_url_HQ"), author_nickname, "video", ENCRYPTION_KEY, BASE_URL
                ),
                "no_watermark": generate_encrypted_download_link(
                    video_urls.get("nwm_video_url"), author_nickname, "video", ENCRYPTION_KEY, BASE_URL
                ),
                "no_watermark_hd": generate_encrypted_download_link(
                    video_urls.get("nwm_video_url_HQ"), author_nickname, "video", ENCRYPTION_KEY, BASE_URL
                )
            }
            
            # Add mp3 link (already generated above)
            if mp3_link:
                download_links["mp3"] = mp3_link
            
            # Remove null values
            metadata["download_link"] = {k: v for k, v in download_links.items() if v is not None}
            
            return {
                "status": "tunnel",
                "photos": [],
                **metadata
            }
            
    except Exception as e:
        # Log the error with traceback
        import traceback
        print(f"Error in generate_json_response: {str(e)}")
        print(traceback.format_exc())
        
        # Return a minimal valid response
        return {
            "status": "error",
            "error": f"Error processing response: {str(e)}",
            "url": url
        }

@app.post("/tiktok")
async def tiktok_endpoint(request: TikTokRequest):
    """Handle TikTok URL processing"""
    if not request.url:
        raise HTTPException(status_code=400, detail="URL parameter is required")
    
    try:
        # Fetch data from the hybrid API
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{HYBRID_API_URL}?url={request.url}&minimal=true",
                headers={"Content-Type": "application/json"},
                timeout=30.0
            )
            
            if response.status_code != 200:
                raise HTTPException(
                    status_code=500, 
                    detail=f"Failed to fetch data from external API: {response.status_code}"
                )
            
            data = response.json()
            
            # Generate and return JSON response
            return generate_json_response(data, request.url)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing request: {str(e)}")

async def download_file(url: str, output_path: str):
    """Download a file from URL to the specified path"""
    async with httpx.AsyncClient() as client:
        async with client.stream("GET", url) as response:
            if response.status_code != 200:
                raise HTTPException(status_code=500, detail=f"Failed to download file: {response.status_code}")
            
            with open(output_path, 'wb') as f:
                async for chunk in response.aiter_bytes():
                    f.write(chunk)

@app.get("/download")
async def download_endpoint(data: str):
    """Handle file downloads with decryption - directly stream from source to client"""
    if not data:
        raise HTTPException(status_code=400, detail="Encrypted data parameter is required")
    
    try:
        # Decrypt the data
        decrypted_data = decrypt(data, ENCRYPTION_KEY)
        parsed_data = json.loads(decrypted_data)
        
        url = parsed_data.get("url")
        author = parsed_data.get("author")
        file_type = parsed_data.get("type")
        
        if not url or not author or not file_type:
            raise HTTPException(status_code=400, detail="Invalid decrypted data: missing url, author, or type")
        
        # Determine content type and file extension
        content_type_map = {
            "mp3": ("audio/mpeg", "mp3"),
            "video": ("video/mp4", "mp4"),
            "image": ("image/jpeg", "jpg")
        }
        
        if file_type not in content_type_map:
            raise HTTPException(status_code=400, detail="Invalid file type specified")
        
        content_type, file_extension = content_type_map[file_type]
        
        # Configure the filename
        filename = f"{author}.{file_extension}"
        encoded_filename = quote(filename)
        
        
        async def stream_file():
            async with httpx.AsyncClient() as client:
                async with client.stream("GET", url) as response:
                    if response.status_code != 200:
                        raise HTTPException(status_code=502, detail=f"Failed to download from source: {response.status_code}")
                    
                    async for chunk in response.aiter_bytes(chunk_size=8192):  # 8KB chunks
                        yield chunk
        
        # Return a streaming response
        return StreamingResponse(
            content=stream_file(),
            media_type=content_type,
            headers={
                "x-filename": encoded_filename,
                "Content-Disposition": f'attachment; filename="{encoded_filename}"; filename*=UTF-8\'\'{encoded_filename}'
            }
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error downloading file: {str(e)}")


# Optimization 10: Asynchronous FFmpeg Processing
async def create_slideshow(images: List[str], audio_path: str, output_path: str):
    """Create a slideshow video from images and audio using FFmpeg asynchronously"""
    import subprocess
    
    # Prepare FFmpeg command
    filter_complex = []
    
    # Scale and pad each image
    for i, _ in enumerate(images):
        filter_complex.append(
            f"[{i}:v]scale=w=1080:h=1920:force_original_aspect_ratio=decrease,"
            f"pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v{i}]"
        )
    
    # Concatenate all scaled/padded video streams
    concat_inputs = ''.join(f"[v{i}]" for i in range(len(images)))
    filter_complex.append(f"{concat_inputs}concat=n={len(images)}:v=1:a=0[vout]")
    
    # Calculate the total duration of the video
    video_duration = len(images) * 3  # 3 seconds per image
    
    # Add audio filter to trim the looping audio to the video duration
    filter_complex.append(f"[{len(images)}:a]atrim=0:{video_duration}[aout]")
    
    # Build the command
    cmd = ["ffmpeg"]
    
    # Add input images with loop and duration
    for image in images:
        cmd.extend(["-loop", "1", "-t", "3", "-i", image])
    
    # Add audio with loop
    cmd.extend(["-stream_loop", "-1", "-i", audio_path])
    
    # Add filter complex
    cmd.extend(["-filter_complex", ";".join(filter_complex)])
    
    # Add mapping and output options
    cmd.extend([
        "-map", "[vout]",
        "-map", "[aout]",
        "-pix_fmt", "yuv420p",
        "-preset", "medium",  # Balance between speed and quality
        "-c:v", "libx264",
        "-c:a", "aac",
        "-fps_mode", "cfr",
        "-strict", "experimental",
        "-b:a", "192k",
        "-shortest",  # End when shortest input ends
        output_path
    ])
    
    # Use event loop's executor to run FFmpeg command asynchronously
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,  # Uses the default executor
        _run_ffmpeg_process,
        cmd, output_path
    )
    
    return output_path

def _run_ffmpeg_process(cmd, output_path):
    """Run FFmpeg process synchronously - to be used with run_in_executor"""
    import subprocess
    
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    stdout, stderr = process.communicate()
    
    if process.returncode != 0:
        raise Exception(f"FFmpeg error: {stderr.decode()}")
    
    return output_path

# Optimization 3: Concurrent Processing
@app.get("/download-slideshow")
async def download_slideshow_endpoint(url: str, background_tasks: BackgroundTasks):
    """Create and download a slideshow from TikTok photo post with concurrent processing"""
    if not url:
        raise HTTPException(status_code=400, detail="URL parameter is required")
    
    try:
        # Decrypt the URL
        decrypted_url = decrypt(url, ENCRYPTION_KEY)
        
        # Fetch data from the hybrid API
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{HYBRID_API_URL}?url={decrypted_url}&minimal=true",
                headers={"Content-Type": "application/json"},
                timeout=30.0
            )
            
            if response.status_code != 200:
                raise HTTPException(
                    status_code=500, 
                    detail=f"Failed to fetch data from external API: {response.status_code}"
                )
            
            data = response.json()["data"]
            
            if data["type"] != "image":
                raise HTTPException(status_code=400, detail="Only image posts are supported")
            
            # Create a unique temp directory with aweme_id + author uid as name
            folder_name = f"{data['aweme_id']}_{data['author']['uid']}"
            temp_dir = os.path.join(TEMP_DIR, folder_name)
            os.makedirs(temp_dir, exist_ok=True)
            
            # Track creation time for temp directory cleanup
            file_timestamps[temp_dir] = datetime.now()
            
            # Download images concurrently
            image_urls = data["image_data"]["no_watermark_image_list"]
            image_paths = []
            download_tasks = []
            
            for i, image_url in enumerate(image_urls):
                image_path = os.path.join(temp_dir, f"image_{i}.jpg")
                image_paths.append(image_path)
                download_tasks.append(download_file(image_url, image_path))
            
            # Use asyncio.gather to download all images concurrently
            await asyncio.gather(*download_tasks)
            
            # Download audio
            # Use helper function to safely get audio URL
            audio_url = get_first_from_nested_list(data["music"], ["play_url", "url_list"])
            if not audio_url:
                raise HTTPException(status_code=500, detail="Could not find audio URL")
                
            audio_path = os.path.join(temp_dir, "audio.mp3")
            await download_file(audio_url, audio_path)
            
            # Create slideshow
            output_path = os.path.join(temp_dir, "slideshow.mp4")
            await create_slideshow(image_paths, audio_path, output_path)
            
            # Generate filename
            author_nickname = ''.join(char if char.isalnum() else '_' for char in data["author"]["nickname"])
            filename = f"{author_nickname}_{int(time.time())}.mp4"
            
            # Add task to remove temp files after request completes
            background_tasks.add_task(lambda: shutil.rmtree(temp_dir) if os.path.exists(temp_dir) else None)
            
            # Return the file
            return FileResponse(
                path=output_path,
                filename=filename,
                media_type="video/mp4"
            )
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error creating slideshow: {str(e)}")

    
if __name__ == "__main__":
    # Optimization 7: Use uvloop for better performance
    uvloop.install()
    uvicorn.run(
        "main:app", 
        host="0.0.0.0", 
        port=3029, 
        reload=False,
        access_log=False,  # Nonaktifkan access log
        log_level="warning"  # Set log level ke paling minimal
    )