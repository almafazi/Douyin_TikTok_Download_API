package utils

import (
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
	"encoding/base64"
	"tiktok-downloader/config"
	"tiktok-downloader/models"
)

func Encrypt(text string, key string, ttlInSeconds int) (string, error) {
    // Waktu kedaluwarsa - format Unix timestamp (integer)
    expires := time.Now().Unix() + int64(ttlInSeconds)
    
    // Gabungkan waktu kedaluwarsa dan teks dengan pemisah
    payload := fmt.Sprintf("%d:%s", expires, text)
    
    // XOR enkripsi - sangat sederhana
    encBytes := make([]byte, len(payload))
    keyBytes := []byte(key)
    keyLen := len(keyBytes)
    
    for i := 0; i < len(payload); i++ {
        encBytes[i] = payload[i] ^ keyBytes[i%keyLen]
    }
    
    // Gunakan Base64 URL-safe untuk hasil yang lebih pendek
    return base64.RawURLEncoding.EncodeToString(encBytes), nil
}

func Decrypt(encryptedText string, key string) (string, error) {
    // Decode Base64 URL-safe
    encBytes, err := base64.RawURLEncoding.DecodeString(encryptedText)
    if err != nil {
        return "", err
    }
    
    // XOR dekripsi
    decBytes := make([]byte, len(encBytes))
    keyBytes := []byte(key)
    keyLen := len(keyBytes)
    
    for i := 0; i < len(encBytes); i++ {
        decBytes[i] = encBytes[i] ^ keyBytes[i%keyLen]
    }
    
    // Pisahkan waktu kedaluwarsa dan teks
    parts := strings.SplitN(string(decBytes), ":", 2)
    if len(parts) != 2 {
        return "", fmt.Errorf("Invalid Link.")
    }
    
    // Verifikasi waktu kedaluwarsa
    expires, err := strconv.ParseInt(parts[0], 10, 64)
    if err != nil {
        return "", err
    }
    
    if time.Now().Unix() > expires {
        return "", fmt.Errorf("Link Expired.")
    }
    
    return parts[1], nil
}

// EncryptJSON is a convenience function that encrypts a JSON object
func EncryptJSON(data interface{}, key string, ttlInSeconds int) (string, error) {
	jsonData, err := json.Marshal(data)
	if err != nil {
		return "", fmt.Errorf("error marshaling data to JSON: %v", err)
	}
	
	return Encrypt(string(jsonData), key, ttlInSeconds)
}

// DecryptJSON is a convenience function that decrypts a JSON object
func DecryptJSON(encryptedText string, key string, target interface{}) error {
	decryptedText, err := Decrypt(encryptedText, key)
	if err != nil {
		return err
	}
	
	return json.Unmarshal([]byte(decryptedText), target)
}

// GenerateEncryptedDownloadLink generates an encrypted download link
func GenerateEncryptedDownloadLink(
	url, authorNickname, mediaType string, cfg *config.AppConfig, expiry int,
) string {
	if url == "" {
		return ""
	}

	data := models.DownloadData{
		URL:    url,
		Author: authorNickname,
		Type:   mediaType,
	}

	encrypted, err := EncryptJSON(data, cfg.EncryptionKey, expiry)
	if err != nil {
		log.Printf("Error generating download link: %v", err)
		return ""
	}

	return fmt.Sprintf("%s/download?data=%s", cfg.BaseURL, encrypted)
}