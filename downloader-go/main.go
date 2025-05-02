package main

import (
	"log"
	"net/http"
	"time"

	"tiktok-downloader/config"
	"tiktok-downloader/handlers"
	"tiktok-downloader/middleware"
	"tiktok-downloader/utils"

	"github.com/gin-gonic/gin"
)

func main() {
	// Initialize app config
	cfg := config.LoadConfig()

	// Create temp directory if it doesn't exist
	if err := utils.InitTempDir(cfg.TempDir); err != nil {
		log.Fatalf("Failed to create temp directory: %v", err)
	}

	// Start background cleanup goroutine
	go utils.CleanupTempFiles(cfg.TempDir)

	// Set release mode for production
	gin.SetMode(gin.ReleaseMode)

	// Create a new gin engine
	router := gin.New()

	// Add middleware
	router.Use(gin.Recovery())
	router.Use(gin.Logger())
	
	// Add CORS middleware
	router.Use(middleware.CorsMiddleware())
	
	// Add GZIP compression middleware
	router.Use(middleware.GzipMiddleware())

	// Create handler context with dependencies
	handlerContext := &handlers.HandlerContext{
		Config: cfg,
	}

	// Register routes
	router.POST("/tiktok", handlerContext.TikTokHandler)
	router.GET("/download", handlerContext.DownloadHandler)
	router.GET("/download-slideshow", handlerContext.DownloadSlideshowHandler)
	
	// Health check endpoint
	router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status": "ok",
			"time":   time.Now().Format(time.RFC3339),
		})
	})

	// Get port from environment variable or use default
	addr := ":" + cfg.Port

	// Create and configure the HTTP server
	server := &http.Server{
		Addr:         addr,
		Handler:      router,
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Log configuration info
	log.Printf("Starting server with configuration:")
	log.Printf("- Base URL: %s", cfg.BaseURL)
	log.Printf("- Temp directory: %s", cfg.TempDir)
	log.Printf("- Hybrid API URL: %s", cfg.HybridAPIURL)

	// Start the server
	log.Printf("Server starting on port %s", cfg.Port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Failed to start server: %v", err)
	}
}