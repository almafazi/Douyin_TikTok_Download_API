package main

import (
	"bufio"
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

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/joho/godotenv"
)

// Environment variables
var (
	PORT          string
	BASE_URL      string
	ENCRYPTION_KEY string
	DOUYIN_API_URL string
	TEMP_DIR      string
)

// ContentType mapping
var contentTypes = map[string][]string{
	"mp3":   {"audio/mpeg", "mp3"},
	"video": {"video/mp4", "mp4"},
	"image": {"image/jpeg", "jpg"},
}

// Response structures
type TikTokResponse struct {
	Status           string              `json:"status"`
	Photos           []PhotoItem         `json:"photos,omitempty"`
	Title            string              `json:"title"`
	Description      string              `json:"description"`
	Statistics       Statistics          `json:"statistics"`
	Artist           string              `json:"artist"`
	Cover            string              `json:"cover"`
	Duration         int                 `json:"duration"`
	Audio            string              `json:"audio"`
	DownloadLink     map[string]any      `json:"download_link"`
	MusicDuration    int                 `json:"music_duration"`
	Author           Author              `json:"author"`
	DownloadSlideshowLink string `json:"download_slideshow_link,omitempty"` // Renamed from SlideshowLink
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

// Main function
func main() {
	// Load environment variables
	loadEnv()

	// Initialize temporary directory
	os.MkdirAll(TEMP_DIR, 0755)

	// Start cleanup scheduler
	initCleanupSchedule("*/15 * * * *")

	// Create Fiber app
	app := fiber.New(fiber.Config{
		ErrorHandler: func(c *fiber.Ctx, err error) error {
			code := fiber.StatusInternalServerError
			if e, ok := err.(*fiber.Error); ok {
				code = e.Code
			}
			return c.Status(code).JSON(fiber.Map{
				"error": err.Error(),
			})
		},
	})

	// Middleware
	app.Use(cors.New(cors.Config{
		AllowOrigins: "*",
		AllowMethods: "GET,POST,OPTIONS",
		AllowHeaders: "Origin,Content-Type,Content-Length,Accept-Encoding,Authorization",
		ExposeHeaders: "Content-Disposition,X-Filename",
	}))

	// Routes
	app.Post("/tiktok", handleTikTok)
	app.Get("/download", handleDownload)
	app.Get("/download-slideshow", handleSlideshow)
	app.Get("/health", handleHealth)

	// 404 handler
	app.Use(func(c *fiber.Ctx) error {
		return c.Status(404).JSON(fiber.Map{
			"error": "Route not found",
		})
	})

	// Start server
	log.Printf("Server started on port %s", PORT)
	log.Printf("Base URL: %s", BASE_URL)
	log.Printf("Temp directory: %s", TEMP_DIR)
	log.Printf("Hybrid API URL: %s", DOUYIN_API_URL)
	log.Fatal(app.Listen(":" + PORT))
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
func handleHealth(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{
		"status": "ok",
		"time":   time.Now().Format(time.RFC3339),
	})
}

// TikTok data processing handler
func handleTikTok(c *fiber.Ctx) error {
	// Parse request body
	var req struct {
		URL string `json:"url"`
	}

	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
	}

	// Validate URL
	if req.URL == "" {
		return fiber.NewError(fiber.StatusBadRequest, "URL parameter is required")
	}

	// Check if URL is from TikTok or Douyin
	if !strings.Contains(req.URL, "tiktok.com") && !strings.Contains(req.URL, "douyin.com") {
		return fiber.NewError(fiber.StatusBadRequest, "Only TikTok and Douyin URLs are supported")
	}

	// Fetch data from hybrid API
	data, err := fetchTikTokData(req.URL, true)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}

	// Process response
	response, err := generateJsonResponse(data, req.URL)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}

	return c.JSON(response)
}

// Download handler
func handleDownload(c *fiber.Ctx) error {
	// Get encrypted data from query
	encryptedData := c.Query("data")
	if encryptedData == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Encrypted data parameter is required")
	}

	// Decrypt the data
	downloadData, err := DecryptDownloadData(encryptedData, ENCRYPTION_KEY)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Failed to decrypt data: "+err.Error())
	}

	// Validate download data
	if downloadData.URL == "" || downloadData.Author == "" || downloadData.Type == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid decrypted data: missing url, author, or type")
	}

	// Determine content type and file extension
	contentTypeInfo, exists := contentTypes[downloadData.Type]
	if !exists {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid file type specified")
	}

	contentType, fileExtension := contentTypeInfo[0], contentTypeInfo[1]

	// Configure the filename
	filename := fmt.Sprintf("%s.%s", downloadData.Author, fileExtension)
	encodedFilename := url.QueryEscape(filename)

	// Stream the file
	return streamDownload(downloadData.URL, c, contentType, encodedFilename)
}

// Slideshow download handler
func handleSlideshow(c *fiber.Ctx) error {
	var workDir string

	// Get encrypted URL from query
	encryptedURL := c.Query("url")
	if encryptedURL == "" {
		return fiber.NewError(fiber.StatusBadRequest, "URL parameter is required")
	}

	// Decrypt the URL
	decryptedURL, err := decrypt(encryptedURL, ENCRYPTION_KEY)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Failed to decrypt URL: "+err.Error())
	}

	// Fetch data from hybrid API
	data, err := fetchTikTokData(decryptedURL, true)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, err.Error())
	}

	// Extract video data from response
	videoData, ok := data["data"].(map[string]interface{})
	if !ok {
		return fiber.NewError(fiber.StatusInternalServerError, "Invalid response from API")
	}

	// Check if it's an image post
	isImage := videoData["type"] == "image"
	if !isImage {
		return fiber.NewError(fiber.StatusBadRequest, "Only image posts are supported")
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
		return fiber.NewError(fiber.StatusInternalServerError, "No image data found")
	}

	imageURLs, ok := imageData["no_watermark_image_list"].([]interface{})
	if !ok || len(imageURLs) == 0 {
		return fiber.NewError(fiber.StatusInternalServerError, "No images found")
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
			return fiber.NewError(fiber.StatusInternalServerError, "Failed to download image: "+err.Error())
		}
		imagePaths = append(imagePaths, imagePath)
	}

	if len(imagePaths) == 0 {
		return fiber.NewError(fiber.StatusInternalServerError, "Failed to download any images")
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
		return fiber.NewError(fiber.StatusInternalServerError, "Could not find audio URL")
	}

	// Download audio
	audioPath := filepath.Join(workDir, "audio.mp3")
	if err := downloadFile(audioURL, audioPath); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Failed to download audio: "+err.Error())
	}

	// Create slideshow
	outputPath := filepath.Join(workDir, "slideshow.mp4")
	if err := createSlideshow(imagePaths, audioPath, outputPath); err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Failed to create slideshow: "+err.Error())
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

	// Track when the response finishes
	c.Context().SetBodyStreamWriter(func(w *bufio.Writer) {
		defer cleanupFolder(workDir)

		file, err := os.Open(outputPath)
		if err != nil {
			log.Printf("Error opening file: %v", err)
			return
		}
		defer file.Close()

		// Copy the file to the response
		if _, err := io.Copy(w, file); err != nil {
			log.Printf("Error streaming file: %v", err)
			return
		}
	})

	// Set headers
	c.Set("Content-Type", "video/mp4")
	c.Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	
	return nil
}

// Helper functions

// Stream a file from a URL to the response
func streamDownload(url string, c *fiber.Ctx, contentType, encodedFilename string) error {
    // Create HTTP client with timeout
    client := &http.Client{
        Timeout: 120 * time.Second,
    }

    // Log the request
    log.Printf("Starting download from: %s", url)

    // Fetch the file from source
    resp, err := client.Get(url)
    if err != nil {
        log.Printf("Download error: %v", err)
        return fiber.NewError(fiber.StatusInternalServerError, "Failed to download from source: "+err.Error())
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        log.Printf("Source returned status: %d", resp.StatusCode)
        return fiber.NewError(fiber.StatusInternalServerError, fmt.Sprintf("Source returned error: %d", resp.StatusCode))
    }

    // Log response headers and size
    log.Printf("Download response received, Content-Length: %s", resp.Header.Get("Content-Length"))

    // Set headers
    c.Set("Content-Type", contentType)
    c.Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, encodedFilename, encodedFilename))
    c.Set("x-filename", encodedFilename)

    // Copy the response body to the client
    _, copyErr := io.Copy(c, resp.Body)
    if copyErr != nil {
        log.Printf("Error streaming response: %v", copyErr)
        return copyErr
    }

    log.Printf("Download completed successfully")
    return nil
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

// generateJsonResponse mengubah data API menjadi format respons yang konsisten dengan Node.js
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
			
			// Hapus nilai null/nil dari map download_link untuk konsistensi dengan Node.js
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