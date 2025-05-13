package main

import (
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/robfig/cron/v3"
)

// cleanupFolder removes a specific folder from the temp directory
func cleanupFolder(folderPath string) error {
	log.Printf("Cleaning up folder: %s", folderPath)
	err := os.RemoveAll(folderPath)
	if err != nil {
		log.Printf("Error removing folder %s: %v", folderPath, err)
		return err
	}
	log.Printf("Successfully removed folder: %s", folderPath)
	return nil
}

// cleanupOldFolders removes all folders in the temp directory that are older than the specified age
func cleanupOldFolders(maxAgeMs int64) (int, error) {
	if maxAgeMs <= 0 {
		maxAgeMs = 60 * 60 * 1000 // Default: 1 hour
	}
	
	log.Printf("Starting cleanup of folders older than %d minutes...", maxAgeMs/1000/60)
	now := time.Now()
	removedCount := 0
	
	// Create temp directory if it doesn't exist
	if err := os.MkdirAll(TEMP_DIR, 0755); err != nil {
		log.Printf("Error creating temp directory: %v", err)
		return 0, err
	}
	
	// Read all entries in the temp directory
	entries, err := os.ReadDir(TEMP_DIR)
	if err != nil {
		log.Printf("Error reading temp directory: %v", err)
		return 0, err
	}
	
	for _, entry := range entries {
		// Skip if not a directory
		if !entry.IsDir() {
			continue
		}
		
		itemPath := filepath.Join(TEMP_DIR, entry.Name())
		
		// Get directory info
		info, err := entry.Info()
		if err != nil {
			log.Printf("Error getting info for %s: %v", itemPath, err)
			continue
		}
		
		// Calculate age
		age := now.Sub(info.ModTime())
		ageMs := age.Milliseconds()
		
		// If folder is older than the specified age, remove it
		if ageMs > maxAgeMs {
			log.Printf("Found old folder (%s, age: %d minutes), removing...",
				entry.Name(), ageMs/1000/60)
			
			if err := cleanupFolder(itemPath); err == nil {
				removedCount++
			}
		}
	}
	
	log.Printf("Cleanup complete. Removed %d folders.", removedCount)
	return removedCount, nil
}

// initCleanupSchedule initializes the cleanup schedule
func initCleanupSchedule(schedule string) {
	log.Printf("Setting up cleanup schedule: %s", schedule)
	
	// Create a new cron scheduler
	c := cron.New()
	
	// Schedule the cleanup task
	_, err := c.AddFunc(schedule, func() {
		log.Printf("Running scheduled cleanup at %s", time.Now().Format(time.RFC3339))
		count, err := cleanupOldFolders(60 * 60 * 1000) // 1 hour
		if err != nil {
			log.Printf("Error during scheduled cleanup: %v", err)
		} else {
			log.Printf("Scheduled cleanup removed %d folders", count)
		}
	})
	
	if err != nil {
		log.Printf("Invalid cron schedule: %s. Using default schedule: Every hour", schedule)
		_, _ = c.AddFunc("0 * * * *", func() {
			log.Printf("Running default scheduled cleanup at %s", time.Now().Format(time.RFC3339))
			count, err := cleanupOldFolders(60 * 60 * 1000) // 1 hour
			if err != nil {
				log.Printf("Error during scheduled cleanup: %v", err)
			} else {
				log.Printf("Default scheduled cleanup removed %d folders", count)
			}
		})
	}
	
	// Start the scheduler
	c.Start()
	
	// Run an initial cleanup on startup
	go func() {
		count, err := cleanupOldFolders(60 * 60 * 1000) // 1 hour
		if err != nil {
			log.Printf("Error during initial cleanup: %v", err)
		} else {
			log.Printf("Initial cleanup removed %d folders", count)
		}
	}()
	
	log.Println("Cleanup scheduler initialized")
}