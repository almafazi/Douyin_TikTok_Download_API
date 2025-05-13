package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
)

// Environment variables
var (
	PORT           string
	BASE_URL       string
	ENCRYPTION_KEY string
	DOUYIN_API_URL string
	TEMP_DIR       string
)

// ContentType mapping
var contentTypes = map[string][]string{
	"mp3":   {"audio/mpeg", "mp3"},
	"video": {"video/mp4", "mp4"},
	"image": {"image/jpeg", "jpg"},
}

// Response structures
type TikTokResponse struct {
	Status               string         `json:"status"`
	Photos               []PhotoItem    `json:"photos,omitempty"`
	Title                string         `json:"title"`
	Description          string         `json:"description"`
	Statistics           Statistics     `json:"statistics"`
	Artist               string         `json:"artist"`
	Cover                string         `json:"cover"`
	Duration             int            `json:"duration"`
	Audio                string         `json:"audio"`
	DownloadLink         map[string]any `json:"download_link"`
	MusicDuration        int            `json:"music_duration"`
	Author               Author         `json:"author"`
	DownloadSlideshowLink string         `json:"download_slideshow_link,omitempty"`
}

type PhotoItem struct {
	Type string `json:"type"`
	URL  string `json:"url"`
}

type Statistics struct {
	RepostCount  int `json:"repost_count"`
	CommentCount int `json:"comment_count"`
	DiggCount    int `json:"digg_count"`
	PlayCount    int `json:"play_count"`
}

type Author struct {
	Nickname  string `json:"nickname"`
	Signature string `json:"signature"`
	Avatar    string `json:"avatar"`
}

type DownloadData struct {
	URL    string `json:"url"`
	Author string `json:"author"`
	Type   string `json:"type"`
}

// Request structures
type TikTokRequest struct {
	URL string `json:"url" binding:"required"`
}

// Main function
func main() {
	// Load environment variables
	loadEnv()

	// Initialize temporary directory
	os.MkdirAll(TEMP_DIR, 0755)

	// Start cleanup scheduler
	initCleanupSchedule("*/15 * * * *")

	// Set Gin to release mode in production
	gin.SetMode(gin.ReleaseMode)

	// Create Gin router
	router := gin.Default()

	// Configure CORS
	router.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"*"},
		AllowMethods:     []string{"GET", "POST", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Content-Length", "Accept-Encoding", "Authorization"},
		ExposeHeaders:    []string{"Content-Disposition", "X-Filename"},
		AllowCredentials: false,
		MaxAge:           12 * time.Hour,
	}))

	// Routes
	router.POST("/tiktok", handleTikTok)
	router.GET("/download", handleDownload)
	router.GET("/download-slideshow", handleSlideshow)
	router.GET("/health", handleHealth)

	// 404 handler
	router.NoRoute(func(c *gin.Context) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Route not found"})
	})

	// Start server
	log.Printf("Server started on port %s", PORT)
	log.Printf("Base URL: %s", BASE_URL)
	log.Printf("Temp directory: %s", TEMP_DIR)
	log.Printf("Hybrid API URL: %s", DOUYIN_API_URL)
	log.Fatal(router.Run(":" + PORT))
}

// Load environment variables
func loadEnv() {
	// Try to load from .env file
	godotenv.Load()

	// Set variables with defaults
	PORT = getEnv("PORT", "6075")
	BASE_URL = getEnv("BASE_URL", "http://localhost:"+PORT)
	ENCRYPTION_KEY = getEnv("ENCRYPTION_KEY", "overflow")
	DOUYIN_API_URL = getEnv("DOUYIN_API_URL", "http://127.0.0.1:3035/api/hybrid/video_data")
	TEMP_DIR = filepath.Join(".", "temp")
}

// Get environment variable with fallback
func getEnv(key, fallback string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return fallback
}

// Health check handler
func handleHealth(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status": "ok",
		"time":   time.Now().Format(time.RFC3339),
	})
}

// TikTok data processing handler
func handleTikTok(c *gin.Context) {
	// Parse request body
	var req TikTokRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	// Validate URL
	if req.URL == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "URL parameter is required"})
		return
	}

	// Check if URL is from TikTok or Douyin
	if !strings.Contains(req.URL, "tiktok.com") && !strings.Contains(req.URL, "douyin.com") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Only TikTok and Douyin URLs are supported"})
		return
	}

	// Fetch data from hybrid API
	data, err := fetchTikTokData(req.URL, true)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Process response
	response, err := generateJsonResponse(data, req.URL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, response)
}

// Download handler
func handleDownload(c *gin.Context) {
	// Get encrypted data from query
	encryptedData := c.Query("data")
	if encryptedData == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Encrypted data parameter is required"})
		return
	}

	// Decrypt the data
	downloadData, err := DecryptDownloadData(encryptedData, ENCRYPTION_KEY)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to decrypt data: " + err.Error()})
		return
	}

	// Validate download data
	if downloadData.URL == "" || downloadData.Author == "" || downloadData.Type == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid decrypted data: missing url, author, or type"})
		return
	}

	// Determine content type and file extension
	contentTypeInfo, exists := contentTypes[downloadData.Type]
	if !exists {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid file type specified"})
		return
	}

	contentType, fileExtension := contentTypeInfo[0], contentTypeInfo[1]

	// Configure the filename
	filename := fmt.Sprintf("%s.%s", downloadData.Author, fileExtension)
	encodedFilename := url.QueryEscape(filename)

	// Stream the file
	streamDownload(downloadData.URL, c, contentType, encodedFilename)
}

// Slideshow download handler
func handleSlideshow(c *gin.Context) {
	var workDir string

	// Get encrypted URL from query
	encryptedURL := c.Query("url")
	if encryptedURL == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "URL parameter is required"})
		return
	}

	// Decrypt the URL
	decryptedURL, err := decrypt(encryptedURL, ENCRYPTION_KEY)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to decrypt URL: " + err.Error()})
		return
	}

	// Fetch data from hybrid API
	data, err := fetchTikTokData(decryptedURL, true)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Extract video data from response
	videoData, ok := data["data"].(map[string]interface{})
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Invalid response from API"})
		return
	}

	// Check if it's an image post
	isImage := videoData["type"] == "image"
	if !isImage {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Only image posts are supported"})
		return
	}

	// Create unique temp directory
	awemeID, _ := videoData["aweme_id"].(string)
	if awemeID == "" {
		awemeID = "unknown"
	}

	authorData, _ := videoData["author"].(map[string]interface{})
	authorUID := "unknown"
	if authorData != nil {
		if uid, ok := authorData["uid"].(string); ok {
			authorUID = uid
		}
	}

	folderName := fmt.Sprintf("%s_%s_%d", awemeID, authorUID, time.Now().UnixNano())
	workDir = filepath.Join(TEMP_DIR, folderName)
	os.MkdirAll(workDir, 0755)

	defer func() {
		// Cleanup on error
		if err != nil && workDir != "" {
			cleanupFolder(workDir)
		}
	}()

	// Get image URLs
	imageData, ok := videoData["image_data"].(map[string]interface{})
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No image data found"})
		return
	}

	imageURLs, ok := imageData["no_watermark_image_list"].([]interface{})
	if !ok || len(imageURLs) == 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No images found"})
		return
	}

	// Download images
	imagePaths := []string{}
	for i, imgURL := range imageURLs {
		imgURLStr, ok := imgURL.(string)
		if !ok {
			continue
		}

		imagePath := filepath.Join(workDir, fmt.Sprintf("image_%d.jpg", i))
		if err := downloadFile(imgURLStr, imagePath); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to download image: " + err.Error()})
			return
		}
		imagePaths = append(imagePaths, imagePath)
	}

	if len(imagePaths) == 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to download any images"})
		return
	}

	// Get audio URL
	var audioURL string
	music, ok := videoData["music"].(map[string]interface{})
	if ok {
		playURL, ok := music["play_url"].(map[string]interface{})
		if ok {
			if urlList, ok := playURL["url_list"].([]interface{}); ok && len(urlList) > 0 {
				if first, ok := urlList[0].(string); ok {
					audioURL = first
				}
			} else if url, ok := playURL["url"].(string); ok {
				audioURL = url
			}
		}
	}

	if audioURL == "" {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not find audio URL"})
		return
	}

	// Download audio
	audioPath := filepath.Join(workDir, "audio.mp3")
	if err := downloadFile(audioURL, audioPath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to download audio: " + err.Error()})
		return
	}

	// Create slideshow
	outputPath := filepath.Join(workDir, "slideshow.mp4")
	if err := createSlideshow(imagePaths, audioPath, outputPath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create slideshow: " + err.Error()})
		return
	}

	// Generate filename
	authorNickname := "unknown"
	if authorData != nil {
		if nickname, ok := authorData["nickname"].(string); ok {
			authorNickname = nickname
		}
	}

	// Sanitize filename
	sanitized := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			return r
		}
		return '_'
	}, authorNickname)

	filename := fmt.Sprintf("%s_%d.mp4", sanitized, time.Now().UnixNano())

	// Prepare to stream the file
	c.Header("Content-Type", "video/mp4")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	
	// Open the file
	file, err := os.Open(outputPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open slideshow file"})
		return
	}
	defer file.Close()
	
	// Get file stats for content length
	fileInfo, err := file.Stat()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get file info"})
		return
	}
	
	// Use DataFromReader to stream the file
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	c.DataFromReader(http.StatusOK, fileInfo.Size(), "video/mp4", file, nil)
	
	// Clean up the temp directory after streaming
	go func() {
		cleanupFolder(workDir)
	}()
}

// Helper functions

// Stream a file from a URL to the response
func streamDownload(url string, c *gin.Context, contentType, encodedFilename string) {
	// Create HTTP client with timeout
	client := &http.Client{
		Timeout: 120 * time.Second,
	}

	// Log the request
	log.Printf("Starting download from: %s", url)

	// Create a request so we can modify headers
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		log.Printf("Failed to create request: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create request: " + err.Error()})
		return
	}

	// Add standard headers to appear as a browser
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Connection", "keep-alive")

	// Send the request
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("Download error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to download from source: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("Source returned status: %d", resp.StatusCode)
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Source returned error: %d", resp.StatusCode)})
		return
	}

	// Log response headers and size
	contentLength := resp.ContentLength
	log.Printf("Download response received, Content-Length: %d", contentLength)

	// Set additional headers
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, encodedFilename, encodedFilename))
	c.Header("x-filename", encodedFilename)

	// Use DataFromReader to stream the content directly to the client
	// This handles setting content-length and content-type automatically
	c.DataFromReader(http.StatusOK, contentLength, contentType, resp.Body, nil)

	log.Printf("Download completed successfully")
}

// Download a file from URL to local path
func downloadFile(url, outputPath string) error {
	// Create HTTP client with timeout
	client := &http.Client{
		Timeout: 120 * time.Second,
	}

	// Get the data
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bad status: %s", resp.Status)
	}

	// Create the file
	out, err := os.Create(outputPath)
	if err != nil {
		return err
	}
	defer out.Close()

	// Write the body to file
	_, err = io.Copy(out, resp.Body)
	return err
}

// Fetch TikTok data from the hybrid API
func fetchTikTokData(urlStr string, minimal bool) (map[string]interface{}, error) {
	minimalStr := "false"
	if minimal {
		minimalStr = "true"
	}

	// Build API URL
	apiURL := fmt.Sprintf("%s?url=%s&minimal=%s", DOUYIN_API_URL, url.QueryEscape(urlStr), minimalStr)

	// Create HTTP client with timeout
	client := &http.Client{
		Timeout: 120 * time.Second,
	}

	// Fetch data
	resp, err := client.Get(apiURL)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch data: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("external API returned error: %d", resp.StatusCode)
	}

	// Parse response
	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode API response: %v", err)
	}

	return result, nil
}

// generateJsonResponse processes API data into a consistent format
func generateJsonResponse(data map[string]interface{}, urlStr string) (TikTokResponse, error) {
	// Initialize default response
	response := TikTokResponse{
		DownloadLink: make(map[string]any),
	}

	// Extract video data
	videoData, ok := data["data"].(map[string]interface{})
	if !ok {
		return response, fmt.Errorf("invalid data format")
	}

	// Extract author
	authorData, ok := videoData["author"].(map[string]interface{})
	if !ok {
		return response, fmt.Errorf("invalid author data")
	}

	// Extract statistics
	statsData, ok := videoData["statistics"].(map[string]interface{})
	if !ok {
		statsData = map[string]interface{}{}
	}

	// Extract music URL
	var musicURL string
	musicData, ok := videoData["music"].(map[string]interface{})
	if ok {
		playURL, ok := musicData["play_url"].(map[string]interface{})
		if ok {
			if urlList, ok := playURL["url_list"].([]interface{}); ok && len(urlList) > 0 {
				if first, ok := urlList[0].(string); ok {
					musicURL = first
				}
			} else if u, ok := playURL["url"].(string); ok {
				musicURL = u
			}
		}
	}

	// Determine if post is image type
	isImage, _ := videoData["type"].(string)
	isImageType := isImage == "image"

	// Fill in author details
	author := Author{
		Nickname:  getStringValue(authorData, "nickname"),
		Signature: getStringValue(authorData, "signature"),
		Avatar:    "", // Default empty string
	}

	// Get avatar URL
	avatarThumb, ok := authorData["avatar_thumb"].(map[string]interface{})
	if ok {
		urlList, ok := avatarThumb["url_list"].([]interface{})
		if ok && len(urlList) > 0 {
			if avatarURL, ok := urlList[0].(string); ok {
				author.Avatar = avatarURL
			}
		}
	}

	// Fill in basic metadata
	response.Title = getStringValue(videoData, "desc")
	response.Description = getStringValue(videoData, "desc")
	response.Statistics = Statistics{
		RepostCount:  getIntValue(statsData, "repost_count"),
		CommentCount: getIntValue(statsData, "comment_count"),
		DiggCount:    getIntValue(statsData, "digg_count"),
		PlayCount:    getIntValue(statsData, "play_count"),
	}
	response.Artist = author.Nickname
	response.Author = author
	response.Duration = getIntValue(videoData, "duration")
	response.Audio = musicURL

	// Get cover URL
	coverData, ok := videoData["cover_data"].(map[string]interface{})
	if ok {
		cover, ok := coverData["cover"].(map[string]interface{})
		if ok {
			urlList, ok := cover["url_list"].([]interface{})
			if ok && len(urlList) > 0 {
				if coverURL, ok := urlList[0].(string); ok {
					response.Cover = coverURL
				}
			}
		}
	}

	// Get music duration
	if musicData != nil {
		response.MusicDuration = getIntValue(musicData, "duration")
	}

	// Process image or video specific data
	if isImageType {
		response.Status = "picker"
		
		// Get image URLs
		imageData, ok := videoData["image_data"].(map[string]interface{})
		if ok {
			nwmImageList, ok := imageData["no_watermark_image_list"].([]interface{})
			if ok {
				// Add images to picker
				for _, urlInterface := range nwmImageList {
					if url, ok := urlInterface.(string); ok {
						response.Photos = append(response.Photos, PhotoItem{
							Type: "photo",
							URL:  url,
						})
					}
				}

				// Generate MP3 download link
				if musicURL != "" {
					data := DownloadData{
						URL:    musicURL,
						Author: author.Nickname,
						Type:   "mp3",
					}
					
					encryptedMusicData, err := EncryptDownloadData(data, ENCRYPTION_KEY, 360)
					if err == nil {
						response.DownloadLink["mp3"] = fmt.Sprintf("%s/download?data=%s", BASE_URL, encryptedMusicData)
					}
				}

				// Generate image download links and store as "no_watermark" array
				var noWatermarkLinks []string
				for _, imageURL := range nwmImageList {
					if url, ok := imageURL.(string); ok {
						data := DownloadData{
							URL:    url,
							Author: author.Nickname,
							Type:   "image",
						}
						
						encryptedImageData, err := EncryptDownloadData(data, ENCRYPTION_KEY, 360)
						if err == nil {
							noWatermarkLinks = append(noWatermarkLinks, fmt.Sprintf("%s/download?data=%s", BASE_URL, encryptedImageData))
						}
					}
				}

				if len(noWatermarkLinks) > 0 {
					response.DownloadLink["no_watermark"] = noWatermarkLinks
				}

				// Add slideshow download link
				encryptedSlideshowURL, err := encrypt(urlStr, ENCRYPTION_KEY, 360)
				if err == nil {
					response.DownloadSlideshowLink = fmt.Sprintf("%s/download-slideshow?url=%s", BASE_URL, encryptedSlideshowURL)
				}
			}
		}
	} else {
		response.Status = "tunnel"

		// Get video URLs
		videoURLs, ok := videoData["video_data"].(map[string]interface{})
		if ok {
			// Helper function to generate download links
			addDownloadLink := func(sourceKey, targetKey, linkType string) {
				if url, ok := videoURLs[sourceKey].(string); ok && url != "" {
					data := DownloadData{
						URL:    url,
						Author: author.Nickname,
						Type:   linkType,
					}
					
					encryptedData, err := EncryptDownloadData(data, ENCRYPTION_KEY, 360)
					if err == nil {
						response.DownloadLink[targetKey] = fmt.Sprintf("%s/download?data=%s", BASE_URL, encryptedData)
					}
				}
			}

			// Generate video download links with Node.js compatible keys
			addDownloadLink("wm_video_url", "watermark", "video")
			addDownloadLink("wm_video_url_HQ", "watermark_hd", "video")
			addDownloadLink("nwm_video_url", "no_watermark", "video")
			addDownloadLink("nwm_video_url_HQ", "no_watermark_hd", "video")

			// Generate MP3 download link
			if musicURL != "" {
				data := DownloadData{
					URL:    musicURL,
					Author: author.Nickname,
					Type:   "mp3",
				}
				
				encryptedMusicData, err := EncryptDownloadData(data, ENCRYPTION_KEY, 360)
				if err == nil {
					response.DownloadLink["mp3"] = fmt.Sprintf("%s/download?data=%s", BASE_URL, encryptedMusicData)
				}
			}
			
			// Remove nil values from download_link map for consistency with Node.js
			for key, value := range response.DownloadLink {
				if value == nil {
					delete(response.DownloadLink, key)
				}
			}
		}
	}

	return response, nil
}

// Helper to get string value from map
func getStringValue(data map[string]interface{}, key string) string {
	if val, ok := data[key].(string); ok {
		return val
	}
	return ""
}

// Helper to get int value from map
func getIntValue(data map[string]interface{}, key string) int {
	switch v := data[key].(type) {
	case int:
		return v
	case float64:
		return int(v)
	case string:
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return 0
}