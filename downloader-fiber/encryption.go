package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"time"
)

// Prepare a 32-byte key using SHA-256
func deriveKey(key string) []byte {
	hash := sha256.Sum256([]byte(key))
	return hash[:]
}

// Encrypt data with TTL using AES-GCM (simpler and more secure)
func encrypt(plaintext, key string, ttlInSeconds int) (string, error) {
	// Add timestamp and TTL to the data
	data := struct {
		Text      string `json:"t"`
		Timestamp int64  `json:"ts"`
		TTL       int    `json:"ttl"`
	}{
		Text:      plaintext,
		Timestamp: time.Now().Unix(),
		TTL:       ttlInSeconds,
	}
	
	// Convert to JSON
	jsonData, err := json.Marshal(data)
	if err != nil {
		return "", err
	}
	
	// Derive key
	keyBytes := deriveKey(key)
	
	// Create cipher block
	block, err := aes.NewCipher(keyBytes)
	if err != nil {
		return "", err
	}
	
	// Create GCM cipher mode
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	
	// Create nonce
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	
	// Encrypt
	ciphertext := gcm.Seal(nonce, nonce, jsonData, nil)
	
	// Convert to URL-safe base64
	return base64.RawURLEncoding.EncodeToString(ciphertext), nil
}

// Decrypt data and check TTL
func decrypt(encryptedText, key string) (string, error) {
	// Decode URL-safe base64
	ciphertext, err := base64.RawURLEncoding.DecodeString(encryptedText)
	if err != nil {
		return "", err
	}
	
	// Derive key
	keyBytes := deriveKey(key)
	
	// Create cipher block
	block, err := aes.NewCipher(keyBytes)
	if err != nil {
		return "", err
	}
	
	// Create GCM cipher mode
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	
	// Extract nonce
	if len(ciphertext) < gcm.NonceSize() {
		return "", errors.New("ciphertext too short")
	}
	nonce, ciphertext := ciphertext[:gcm.NonceSize()], ciphertext[gcm.NonceSize():]
	
	// Decrypt
	jsonData, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	
	// Parse JSON
	var data struct {
		Text      string `json:"t"`
		Timestamp int64  `json:"ts"`
		TTL       int    `json:"ttl"`
	}
	if err := json.Unmarshal(jsonData, &data); err != nil {
		return "", err
	}
	
	// Check TTL
	currentTime := time.Now().Unix()
	expirationTime := data.Timestamp + int64(data.TTL)
	if currentTime > expirationTime {
		return "", errors.New("link expired")
	}
	
	return data.Text, nil
}

// EncryptDownloadData encrypts a DownloadData struct
func EncryptDownloadData(data DownloadData, key string, ttlInSeconds int) (string, error) {
	// Convert struct to JSON
	jsonData, err := json.Marshal(data)
	if err != nil {
		return "", err
	}
	
	// Encrypt the JSON string
	return encrypt(string(jsonData), key, ttlInSeconds)
}

// DecryptDownloadData decrypts to a DownloadData struct
func DecryptDownloadData(encryptedText, key string) (DownloadData, error) {
	var data DownloadData
	
	// Decrypt the string
	decrypted, err := decrypt(encryptedText, key)
	if err != nil {
		return data, err
	}
	
	// Convert JSON to struct
	err = json.Unmarshal([]byte(decrypted), &data)
	if err != nil {
		return data, err
	}
	
	return data, nil
}