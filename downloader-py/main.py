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
import uuid
from urllib.parse import quote

from fastapi.responses import StreamingResponse
from fastapi import FastAPI, HTTPException, BackgroundTasks, Response
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware

from crypto import encrypt, decrypt

# Constants
BASE_URL = os.getenv("BASE_URL", "http://localhost:3029")  # From .env file
ENCRYPTION_KEY = "overflow"  # Same key as in original code
TEMP_DIR = os.path.join(os.getcwd(), "temp")
HYBRID_API_URL = "http://host.docker.internal:3035/api/hybrid/video_data"  # Accessing host machine from Docker

# Create temp directory if it doesn't exist
os.makedirs(TEMP_DIR, exist_ok=True)

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

# Background task to remove expired temp files
async def cleanup_temp_files():
    """Remove temporary files and folders older than 1 hour"""
    try:
        current_time = datetime.now()
        for item in os.listdir(TEMP_DIR):
            item_path = os.path.join(TEMP_DIR, item)
            if os.path.isdir(item_path):
                # Get folder modification time
                modified_time = datetime.fromtimestamp(os.path.getmtime(item_path))
                # If older than 1 hour, remove it
                if current_time - modified_time > timedelta(hours=1):
                    try:
                        shutil.rmtree(item_path)
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
        # Run every 15 minutes
        await asyncio.sleep(30 * 60)

def generate_json_response(data: Dict[str, Any], url: str = '') -> Dict[str, Any]:
    """Generate JSON response similar to the original Node.js function"""
    try:
        video_data = data.get("data", {})
        
        # Safely get nested values with fallbacks for all required fields
        author = video_data.get("author", {})
        statistics = video_data.get("statistics", {})
        
        # Handle potential missing music data
        music = video_data.get("music", {})
        play_url = music.get("play_url", {})
        music_url = play_url.get("uri", play_url.get("url", ""))
        
        # Check if it's an image post
        is_image = video_data.get("type") == "image"
        
        # Build author data with safe gets
        filtered_author = {
            "nickname": author.get("nickname", "Unknown"),
            "signature": author.get("signature", ""),
            "avatar": (author.get("avatar_thumb", {}).get("url_list", [""])[0] 
                      if author.get("avatar_thumb", {}).get("url_list") 
                      else '')
        }
        
        # Initialize default values for metadata
        picker = []
        metadata = {
            "title": video_data.get("desc", ""),
            "description": video_data.get("desc", ""),
            "statistics": {
                "repost_count": statistics.get("repost_count", 0),
                "comment_count": statistics.get("comment_count", 0),
                "digg_count": statistics.get("digg_count", 0),
                "play_count": statistics.get("play_count", 0)
            },
            "artist": author.get("nickname", "Unknown"),
            "cover": (video_data.get("cover_data", {}).get("cover", {}).get("url_list", [""])[0] 
                     if video_data.get("cover_data", {}).get("cover", {}).get("url_list") 
                     else None),
            "duration": video_data.get("duration", 0),  # Default to 0 if missing
            "audio": music_url,
            "download_link": {},
            "music_duration": music.get("duration", 0),  # Default to 0 if missing
            "author": filtered_author
        }
        
        if is_image:
            # Safely get image data
            image_data = video_data.get("image_data", {})
            no_watermark_images = image_data.get("no_watermark_image_list", [])
            
            picker = [
                {
                    "type": "photo",
                    "url": img_url
                } for img_url in no_watermark_images
            ]
            
            # Generate encrypted URLs for each image
            encrypted_no_watermark_urls = []
            for img_url in no_watermark_images:
                try:
                    encrypted_url = encrypt(
                        json.dumps({"url": img_url, "author": author.get("nickname", "Unknown"), "type": "image"}), 
                        ENCRYPTION_KEY, 
                        360
                    )
                    encrypted_no_watermark_urls.append(encrypted_url)
                except Exception as e:
                    print(f"Error encrypting image URL: {e}")
            
            # Generate MP3 download link
            try:
                mp3_data = json.dumps({'url': music_url, 'author': author.get("nickname", "Unknown"), 'type': 'mp3'})
                mp3_encrypted = encrypt(mp3_data, ENCRYPTION_KEY, 360)
                metadata["download_link"]["mp3"] = f"{BASE_URL}/download?data={mp3_encrypted}"
            except Exception as e:
                print(f"Error generating MP3 download link: {e}")
            
            # Add all image download links
            metadata["download_link"]["no_watermark"] = [
                f"{BASE_URL}/download?data={encrypted_url}" for encrypted_url in encrypted_no_watermark_urls
            ]
            
            # Add slideshow download link
            try:
                metadata["download_slideshow_link"] = f"{BASE_URL}/download-slideshow?url={encrypt(url, ENCRYPTION_KEY, 360)}"
            except Exception as e:
                print(f"Error generating slideshow link: {e}")
                
        else:
            # Handle video type content
            video_urls = video_data.get("video_data", {})
            
            # Helper function to safely generate download link
            def generate_download_link(url, author_data, media_type):
                if not url:
                    return None
                try:
                    encrypted_url = encrypt(
                        json.dumps({
                            "url": url,
                            "author": author_data.get("nickname", "Unknown"),
                            "type": media_type
                        }),
                        ENCRYPTION_KEY,
                        360
                    )
                    return f"{BASE_URL}/download?data={encrypted_url}"
                except Exception as e:
                    print(f"Error generating download link for {media_type}: {e}")
                    return None
            
            # Generate all download links
            download_links = {
                "watermark": generate_download_link(video_urls.get("wm_video_url"), author, "video"),
                "watermark_hd": generate_download_link(video_urls.get("wm_video_url_HQ"), author, "video"),
                "no_watermark": generate_download_link(video_urls.get("nwm_video_url"), author, "video"),
                "no_watermark_hd": generate_download_link(video_urls.get("nwm_video_url_HQ"), author, "video"),
                "mp3": generate_download_link(music_url, author, "mp3")
            }
            
            # Remove null values
            metadata["download_link"] = {k: v for k, v in download_links.items() if v is not None}
        
        print(f"Successfully generated response with status: {'picker' if is_image else 'tunnel'}")
        return {
            "status": "picker" if is_image else "tunnel",
            "photos": picker,
            **metadata
        }
        
    except Exception as e:
        # Log the error but return a minimal valid response
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


async def create_slideshow(images: List[str], audio_path: str, output_path: str):
    """Create a slideshow video from images and audio using FFmpeg"""
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
    video_duration = len(images) * 3  # 5 seconds per image
    
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
        "-fps_mode","cfr",
        "-strict", "experimental",
        "-b:a", "192k",
        "-shortest",  # End when shortest input ends
        output_path
    ])
    
    # Execute the command
    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    
    stdout, stderr = await process.communicate()
    
    if process.returncode != 0:
        raise Exception(f"FFmpeg error: {stderr.decode()}")
    
    return output_path

@app.get("/download-slideshow")
async def download_slideshow_endpoint(url: str, background_tasks: BackgroundTasks):
    """Create and download a slideshow from TikTok photo post"""
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
            
            # Download images
            image_urls = data["image_data"]["no_watermark_image_list"]
            image_paths = []
            
            for i, image_url in enumerate(image_urls):
                image_path = os.path.join(temp_dir, f"image_{i}.jpg")
                await download_file(image_url, image_path)
                image_paths.append(image_path)
            
            # Download audio
            audio_url = data["music"]["play_url"]["url_list"][0]
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
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=3029, reload=True)