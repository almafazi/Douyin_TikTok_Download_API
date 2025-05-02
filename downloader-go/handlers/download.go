package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tiktok-downloader/models"
	"tiktok-downloader/utils"

	"github.com/gin-gonic/gin"
)

// DownloadHandler handles file download requests
func (h *HandlerContext) DownloadHandler(c *gin.Context) {
	data := c.Query("data")
	if data == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Encrypted data parameter is required"})
		return
	}

	// Decrypt the data
	var downloadData models.DownloadData
	if err := utils.DecryptJSON(data, h.Config.EncryptionKey, &downloadData); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Error decrypting data: " + err.Error()})
		return
	}

	if downloadData.URL == "" || downloadData.Author == "" || downloadData.Type == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid decrypted data: missing url, author, or type"})
		return
	}

	// Determine content type and file extension
	contentType, fileExtension, ok := h.Config.ContentType(downloadData.Type)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid file type specified"})
		return
	}

	// Configure the filename
	filename := fmt.Sprintf("%s.%s", downloadData.Author, fileExtension)
	encodedFilename := url.QueryEscape(filename)

	// Stream the file from source to client
	httpClient := &http.Client{Timeout: 60 * time.Second}
	resp, err := httpClient.Get(downloadData.URL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to download from source: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("Source returned error: %d", resp.StatusCode)})
		return
	}

	// Set headers
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"; filename*=UTF-8''%s", encodedFilename, encodedFilename))
	c.Header("x-filename", encodedFilename)

	// Stream the file to the client
	c.DataFromReader(http.StatusOK, resp.ContentLength, contentType, resp.Body, nil)
}

// DownloadSlideshowHandler handles slideshow download requests
func (h *HandlerContext) DownloadSlideshowHandler(c *gin.Context) {
	urlParam := c.Query("url")
	if urlParam == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "URL parameter is required"})
		return
	}

	// Decrypt the URL
	decryptedURL, err := utils.Decrypt(urlParam, h.Config.EncryptionKey)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Error decrypting URL: " + err.Error()})
		return
	}

	// Fetch data from the hybrid API
	apiURL := fmt.Sprintf("%s?url=%s&minimal=true", h.Config.HybridAPIURL, url.QueryEscape(decryptedURL))
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

	videoData, ok := data["data"].(map[string]interface{})
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Invalid data format"})
		return
	}

	// Check if it's an image post
	isImage := false
	if typeVal, ok := videoData["type"].(string); ok {
		isImage = typeVal == "image"
	}

	if !isImage {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Only image posts are supported"})
		return
	}

	// Create a unique temp directory
	awemeID := fmt.Sprintf("%v", videoData["aweme_id"])
	authorUID := "unknown"
	if author, ok := videoData["author"].(map[string]interface{}); ok {
		if uid, ok := author["uid"].(string); ok {
			authorUID = uid
		}
	}

	folderName := fmt.Sprintf("%s_%s_%d", awemeID, authorUID, time.Now().UnixNano())
	tempDir := filepath.Join(h.Config.TempDir, folderName)
	if err := os.MkdirAll(tempDir, os.ModePerm); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Error creating temp directory: " + err.Error()})
		return
	}

	// Track the temp directory
	utils.TempFiles.Add(tempDir)

	// Schedule cleanup in case of unexpected errors (1 hour)
	utils.ScheduleCleanup(tempDir, time.Hour)

	// Get image URLs
	var imageURLs []string
	if imageData, ok := videoData["image_data"].(map[string]interface{}); ok {
		if nwImages, ok := imageData["no_watermark_image_list"].([]interface{}); ok {
			for _, img := range nwImages {
				if imgStr, ok := img.(string); ok {
					imageURLs = append(imageURLs, imgStr)
				}
			}
		}
	}

	if len(imageURLs) == 0 {
		// Clean up the directory since we won't use it
		os.RemoveAll(tempDir)
		utils.TempFiles.Delete(tempDir)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No images found"})
		return
	}

	// Download images concurrently
	imagePaths := make([]string, len(imageURLs))
	var wg sync.WaitGroup
	var downloadErr error
	var errMutex sync.Mutex

	for i, imageURL := range imageURLs {
		wg.Add(1)
		go func(idx int, url string) {
			defer wg.Done()
			
			imagePath := filepath.Join(tempDir, fmt.Sprintf("image_%d.jpg", idx))
			imagePaths[idx] = imagePath
			
			if err := utils.DownloadFile(url, imagePath); err != nil {
				errMutex.Lock()
				if downloadErr == nil { // only capture the first error
					downloadErr = fmt.Errorf("error downloading image %d: %w", idx, err)
				}
				errMutex.Unlock()
			}
		}(i, imageURL)
	}

	// Wait for all downloads to complete
	wg.Wait()

	// Check for download errors
	if downloadErr != nil {
		os.RemoveAll(tempDir)
		utils.TempFiles.Delete(tempDir)
		c.JSON(http.StatusInternalServerError, gin.H{"error": downloadErr.Error()})
		return
	}

	// Download audio
	audioURL := ""
	if music, ok := videoData["music"].(map[string]interface{}); ok {
		audioURL = utils.GetFirstFromNestedList(music, []string{"play_url", "url_list"}, "")
	}
	
	if audioURL == "" {
		os.RemoveAll(tempDir)
		utils.TempFiles.Delete(tempDir)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Could not find audio URL"})
		return
	}

	audioPath := filepath.Join(tempDir, "audio.mp3")
	if err := utils.DownloadFile(audioURL, audioPath); err != nil {
		os.RemoveAll(tempDir)
		utils.TempFiles.Delete(tempDir)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Error downloading audio: " + err.Error()})
		return
	}

	// Create slideshow
	outputPath := filepath.Join(tempDir, "slideshow.mp4")
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
	defer cancel()

	if err := utils.CreateSlideshow(ctx, imagePaths, audioPath, outputPath); err != nil {
		os.RemoveAll(tempDir)
		utils.TempFiles.Delete(tempDir)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Error creating slideshow: " + err.Error()})
		return
	}

	// Generate filename
	authorNickname := "unknown"
	if author, ok := videoData["author"].(map[string]interface{}); ok {
		if nick, ok := author["nickname"].(string); ok {
			authorNickname = nick
		}
	}
	
	// Sanitize filename
	sanitized := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			return r
		}
		return '_'
	}, authorNickname)
	
	filename := fmt.Sprintf("%s_%d.mp4", sanitized, time.Now().Unix())

	// Set up quick cleanup after serving the file (5 minutes)
	defer utils.ScheduleCleanup(tempDir, 5*time.Minute)

	// Return the file
	c.FileAttachment(outputPath, filename)
}