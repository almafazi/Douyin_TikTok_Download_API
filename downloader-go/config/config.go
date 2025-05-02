package config

import (
	"os"
	"path/filepath"
)

// AppConfig holds all the application configuration
type AppConfig struct {
	BaseURL       string
	EncryptionKey string
	TempDir       string
	HybridAPIURL  string
	Port          string
	ContentTypes  map[string][]string
}

// ContentType returns the content type and file extension for a given media type
func (cfg *AppConfig) ContentType(mediaType string) (string, string, bool) {
	if info, ok := cfg.ContentTypes[mediaType]; ok {
		return info[0], info[1], true
	}
	return "", "", false
}

// LoadConfig loads the application configuration from environment variables
// with fallback to default values
func LoadConfig() *AppConfig {
	config := &AppConfig{
		BaseURL:       getEnv("BASE_URL", "https://tt.y2mate.biz.id"),
		EncryptionKey: getEnv("ENCRYPTION_KEY", "overflow"),
		TempDir:       filepath.Join(".", "temp"),
		HybridAPIURL:  getEnv("DOUYIN_API_URL", "http://douyin_tiktok_download_api:8000/api/hybrid/video_data"),
		Port:          getEnv("PORT", "3021"),
		ContentTypes: map[string][]string{
			"mp3":   {"audio/mpeg", "mp3"},
			"video": {"video/mp4", "mp4"},
			"image": {"image/jpeg", "jpg"},
		},
	}

	return config
}

// getEnv gets an environment variable or returns a default value
func getEnv(key, fallback string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return fallback
}