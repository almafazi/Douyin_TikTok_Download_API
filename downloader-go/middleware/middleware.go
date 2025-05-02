package middleware

import (
	"github.com/gin-contrib/cors"
	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
)

// CorsMiddleware returns a CORS middleware with appropriate configuration
func CorsMiddleware() gin.HandlerFunc {
	config := cors.DefaultConfig()
	config.AllowAllOrigins = true
	config.AllowMethods = []string{"GET", "POST", "OPTIONS"}
	config.AllowHeaders = []string{"Origin", "Content-Type", "Content-Length", "Accept-Encoding", "Authorization"}
	config.ExposeHeaders = []string{"Content-Disposition", "X-Filename"}
	
	return cors.New(config)
}

// GzipMiddleware returns a GZIP compression middleware
func GzipMiddleware() gin.HandlerFunc {
	return gzip.Gzip(gzip.DefaultCompression)
}