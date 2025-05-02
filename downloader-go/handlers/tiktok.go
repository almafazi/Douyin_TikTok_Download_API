package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"tiktok-downloader/config"
	"tiktok-downloader/models"
	"tiktok-downloader/utils"

	"github.com/gin-gonic/gin"
)

// HandlerContext holds dependencies for handlers
type HandlerContext struct {
	Config *config.AppConfig
}

// TikTokHandler handles the TikTok endpoint
func (h *HandlerContext) TikTokHandler(c *gin.Context) {
	var req models.TikTokRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request: " + err.Error()})
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

	// Fetch data from the hybrid API
	apiURL := fmt.Sprintf("%s?url=%s&minimal=true", h.Config.HybridAPIURL, url.QueryEscape(req.URL))
	httpClient := &http.Client{Timeout: 30 * time.Second}

	resp, err := httpClient.Get(apiURL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to fetch data: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": fmt.Sprintf("External API returned error: %d", resp.StatusCode),
		})
		return
	}

	var data map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Error parsing response: " + err.Error()})
		return
	}

	// Generate JSON response
	response, err := generateJSONResponse(data, req.URL, h.Config)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Error processing response: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, response)
}

// generateJSONResponse processes the API response data and generates a structured response
func generateJSONResponse(data map[string]interface{}, url string, cfg *config.AppConfig) (models.TikTokResponse, error) {
	response := models.TikTokResponse{
		Photos:       []models.PhotoItem{},
		DownloadLink: make(map[string]interface{}),
		Statistics:   models.Statistics{},
	}

	// Extract and validate data
	videoData, ok := data["data"].(map[string]interface{})
	if !ok {
		return response, fmt.Errorf("invalid data format")
	}

	// Check content type
	isImage := false
	if typeVal, ok := videoData["type"].(string); ok {
		isImage = typeVal == "image"
	}

	// Extract author data
	author := make(map[string]interface{})
	if authorVal, ok := videoData["author"].(map[string]interface{}); ok {
		author = authorVal
	}

	authorNickname := "Unknown"
	if nick, ok := author["nickname"].(string); ok {
		authorNickname = nick
	}

	// Build author metadata
	response.Author = models.Author{
		Nickname:  authorNickname,
		Signature: fmt.Sprintf("%v", utils.GetNestedValue(author, []string{"signature"}, "")),
		Avatar:    utils.GetFirstFromNestedList(author, []string{"avatar_thumb", "url_list"}, ""),
	}

	// Extract statistics
	statistics := make(map[string]interface{})
	if statsVal, ok := videoData["statistics"].(map[string]interface{}); ok {
		statistics = statsVal
	}

	// Convert statistics values
	response.Statistics = models.Statistics{
		RepostCount:  utils.GetIntStat(statistics, "repost_count"),
		CommentCount: utils.GetIntStat(statistics, "comment_count"),
		DiggCount:    utils.GetIntStat(statistics, "digg_count"),
		PlayCount:    utils.GetIntStat(statistics, "play_count"),
	}

	// Extract music data
	music := make(map[string]interface{})
	if musicVal, ok := videoData["music"].(map[string]interface{}); ok {
		music = musicVal
	} else {
		// Handle case where music data is missing
		log.Printf("Warning: No music data found for URL: %s", url)
	}

	musicURL := ""
	if uri, ok := utils.GetNestedValue(music, []string{"play_url", "uri"}, "").(string); ok && uri != "" {
		musicURL = uri
	} else if url, ok := utils.GetNestedValue(music, []string{"play_url", "url"}, "").(string); ok {
		musicURL = url
	}

	// Build basic metadata
	response.Title = fmt.Sprintf("%v", utils.GetNestedValue(videoData, []string{"desc"}, ""))
	response.Description = fmt.Sprintf("%v", utils.GetNestedValue(videoData, []string{"desc"}, ""))
	response.Artist = authorNickname
	response.Cover = utils.GetFirstFromNestedList(videoData, []string{"cover_data", "cover", "url_list"}, "")
	response.Audio = musicURL
	
	// Duration
	if durVal, ok := videoData["duration"].(float64); ok {
		response.Duration = int(durVal)
	}
	
	// Music duration
	if musicDurVal, ok := music["duration"].(float64); ok {
		response.MusicDuration = int(musicDurVal)
	}

	// Process MP3 download link
	mp3Link := utils.GenerateEncryptedDownloadLink(
		musicURL, authorNickname, "mp3", cfg, 360,
	)
	if mp3Link != "" {
		response.DownloadLink["mp3"] = mp3Link
	}

	// Process based on content type
	if isImage {
		if err := processImageResponse(videoData, authorNickname, url, &response, cfg); err != nil {
			return response, fmt.Errorf("error processing image data: %w", err)
		}
		response.Status = "picker"
	} else {
		if err := processVideoResponse(videoData, authorNickname, musicURL, mp3Link, &response, cfg); err != nil {
			return response, fmt.Errorf("error processing video data: %w", err)
		}
		response.Status = "tunnel"
	}

	return response, nil
}

// processImageResponse handles image-specific response processing
func processImageResponse(videoData map[string]interface{}, authorNickname, url string, response *models.TikTokResponse, cfg *config.AppConfig) error {
	// Get image list
	imageData := make(map[string]interface{})
	if imgDataVal, ok := videoData["image_data"].(map[string]interface{}); ok {
		imageData = imgDataVal
	} else {
		return fmt.Errorf("image data not found")
	}

	var noWatermarkImages []string
	if nwImages, ok := imageData["no_watermark_image_list"].([]interface{}); ok {
		for _, img := range nwImages {
			if imgStr, ok := img.(string); ok {
				noWatermarkImages = append(noWatermarkImages, imgStr)
			}
		}
	}

	if len(noWatermarkImages) == 0 {
		return fmt.Errorf("no images found in image data")
	}

	// Create picker for image gallery
	for _, imgURL := range noWatermarkImages {
		response.Photos = append(response.Photos, models.PhotoItem{
			Type: "photo",
			URL:  imgURL,
		})
	}

	// Generate image download links
	var encryptedImageLinks []string
	for _, imgURL := range noWatermarkImages {
		link := utils.GenerateEncryptedDownloadLink(
			imgURL, authorNickname, "image", cfg, 360,
		)
		if link != "" {
			encryptedImageLinks = append(encryptedImageLinks, link)
		}
	}

	if len(encryptedImageLinks) > 0 {
		response.DownloadLink["no_watermark"] = encryptedImageLinks
	}

	// Add slideshow download link
	encryptedURL, err := utils.Encrypt(url, cfg.EncryptionKey, 360) // Menambahkan parameter TTL (360 detik)
	if err != nil {
		return fmt.Errorf("error encrypting URL for slideshow: %w", err)
	}
	response.SlideshowDownLink = fmt.Sprintf("%s/download-slideshow?url=%s", cfg.BaseURL, encryptedURL)

	return nil
}

// processVideoResponse handles video-specific response processing
func processVideoResponse(videoData map[string]interface{}, authorNickname, musicURL, mp3Link string, response *models.TikTokResponse, cfg *config.AppConfig) error {
	// Video-specific processing
	videoURLs := make(map[string]interface{})
	if videoDataVal, ok := videoData["video_data"].(map[string]interface{}); ok {
		videoURLs = videoDataVal
	} else {
		return fmt.Errorf("video data not found")
	}

	// Generate all video download links
	downloadLinks := make(map[string]string)

	// Helper function to add download link if URL exists
	addLink := func(key, urlKey, mediaType string) {
		if urlVal, ok := videoURLs[urlKey].(string); ok && urlVal != "" {
			link := utils.GenerateEncryptedDownloadLink(
				urlVal, authorNickname, mediaType, cfg, 360,
			)
			if link != "" {
				downloadLinks[key] = link
			}
		}
	}

	addLink("watermark", "wm_video_url", "video")
	addLink("watermark_hd", "wm_video_url_HQ", "video")
	addLink("no_watermark", "nwm_video_url", "video")
	addLink("no_watermark_hd", "nwm_video_url_HQ", "video")

	// Add mp3 link (already generated above)
	if mp3Link != "" {
		downloadLinks["mp3"] = mp3Link
	}

	// Check if we have at least one download link
	if len(downloadLinks) == 0 {
		return fmt.Errorf("no valid video URLs found")
	}

	// Add to response
	for k, v := range downloadLinks {
		response.DownloadLink[k] = v
	}

	return nil
}