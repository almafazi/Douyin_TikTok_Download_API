package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// encrypt encrypts text with key and adds TTL
func encrypt(text, key string, ttlInSeconds int) (string, error) {
	// Create timestamp
	timestamp := time.Now().UnixNano() / int64(time.Millisecond)
	
	// Combine timestamp, TTL, and text
	textWithTimestamp := fmt.Sprintf("%d_*_%d_*_%s", timestamp, ttlInSeconds, text)
	
	// Create cipher
	block, err := createCipher(key)
	if err != nil {
		return "", err
	}
	
	// Encrypt
	ciphertext, err := encryptWithAES(block, []byte(textWithTimestamp))
	if err != nil {
		return "", err
	}
	
	// Encode to base64 and then URL encode
	encoded := base64.StdEncoding.EncodeToString(ciphertext)
	return url.QueryEscape(encoded), nil
}

// decrypt decrypts text with key and verifies TTL
func decrypt(encryptedText, key string) (string, error) {
	// URL decode and then decode base64
	decoded, err := url.QueryUnescape(encryptedText)
	if err != nil {
		return "", err
	}
	
	ciphertext, err := base64.StdEncoding.DecodeString(decoded)
	if err != nil {
		return "", err
	}
	
	// Create cipher
	block, err := createCipher(key)
	if err != nil {
		return "", err
	}
	
	// Decrypt
	decrypted, err := decryptWithAES(block, ciphertext)
	if err != nil {
		return "", err
	}
	
	// Split into timestamp, TTL, and text
	parts := strings.SplitN(string(decrypted), "_*_", 3)
	if len(parts) != 3 {
		return "", errors.New("invalid decrypted format")
	}
	
	// Parse timestamp and TTL
	timestamp, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return "", err
	}
	
	ttlInSeconds, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return "", err
	}
	
	// Calculate expiration time
	expirationTime := timestamp + (ttlInSeconds * 1000) // Convert to milliseconds
	currentTime := time.Now().UnixNano() / int64(time.Millisecond)
	
	// Check if expired
	if currentTime > expirationTime {
		return "", errors.New("link expired and cannot be decrypted")
	}
	
	// Return the original text
	return parts[2], nil
}

// createCipher creates an AES cipher from a key
func createCipher(key string) (cipher.Block, error) {
	// Create a 32-byte key using SHA-256
	hasher := sha256.New()
	hasher.Write([]byte(key))
	hashedKey := hasher.Sum(nil)
	
	// Create the AES cipher
	return aes.NewCipher(hashedKey)
}

// encryptWithAES encrypts plaintext with AES-GCM
func encryptWithAES(block cipher.Block, plaintext []byte) ([]byte, error) {
	// Create GCM
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	
	// Create nonce
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	
	// Encrypt and seal
	ciphertext := gcm.Seal(nonce, nonce, plaintext, nil)
	return ciphertext, nil
}

// decryptWithAES decrypts ciphertext with AES-GCM
func decryptWithAES(block cipher.Block, ciphertext []byte) ([]byte, error) {
	// Create GCM
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	
	// Extract nonce
	if len(ciphertext) < gcm.NonceSize() {
		return nil, errors.New("ciphertext too short")
	}
	
	nonce, ciphertext := ciphertext[:gcm.NonceSize()], ciphertext[gcm.NonceSize():]
	
	// Decrypt
	return gcm.Open(nil, nonce, ciphertext, nil)
}