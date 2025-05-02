package utils

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// TempFileTracker tracks temporary files with timestamps
type TempFileTracker struct {
	sync.RWMutex
	files map[string]time.Time
}

// Global instance of temp file tracker
var TempFiles = TempFileTracker{
	files: make(map[string]time.Time),
}

// Add adds a path to the tracker
func (t *TempFileTracker) Add(path string) {
	t.Lock()
	defer t.Unlock()
	t.files[path] = time.Now()
}

// Get gets a path's timestamp from the tracker
func (t *TempFileTracker) Get(path string) (time.Time, bool) {
	t.RLock()
	defer t.RUnlock()
	timestamp, ok := t.files[path]
	return timestamp, ok
}

// Delete deletes a path from the tracker
func (t *TempFileTracker) Delete(path string) {
	t.Lock()
	defer t.Unlock()
	delete(t.files, path)
}

// InitTempDir initializes the temp directory
func InitTempDir(tempDir string) error {
	return os.MkdirAll(tempDir, os.ModePerm)
}

// ScheduleCleanup schedules a cleanup of a temporary directory
func ScheduleCleanup(path string, delay time.Duration) {
	go func() {
		time.Sleep(delay)
		if err := os.RemoveAll(path); err != nil {
			log.Printf("Error removing temp directory %s: %v", path, err)
		} else {
			log.Printf("Cleaned up temp directory: %s", path)
		}
		TempFiles.Delete(path)
	}()
}

// CleanupTempFiles continuously cleans up temporary files
func CleanupTempFiles(tempDir string) {
	for {
		// Sleep for 15 minutes
		time.Sleep(15 * time.Minute)

		// Get current time
		currentTime := time.Now()

		// Find directories to clean
		toClean := []string{}

		err := filepath.Walk(tempDir, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}

			// Skip the root directory
			if path == tempDir {
				return nil
			}

			// If it's a directory
			if info.IsDir() {
				// Get timestamp from tracker or use file modification time
				timestamp, ok := TempFiles.Get(path)
				if !ok {
					timestamp = info.ModTime()
				}

				// If older than 1 hour, add to cleanup list
				if currentTime.Sub(timestamp) > time.Hour {
					toClean = append(toClean, path)
					return filepath.SkipDir // Skip subfolders
				}
			}

			return nil
		})

		if err != nil {
			log.Printf("Error in cleanup task: %v", err)
		}

		// Clean the directories
		for _, path := range toClean {
			if err := os.RemoveAll(path); err != nil {
				log.Printf("Error removing directory %s: %v", path, err)
			} else {
				log.Printf("Removed old temp directory: %s", path)
				TempFiles.Delete(path)
			}
		}
	}
}

// DownloadFile downloads a file from a URL to a local path
func DownloadFile(url, outputPath string) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to download file: %d", resp.StatusCode)
	}

	file, err := os.Create(outputPath)
	if err != nil {
		return err
	}
	defer file.Close()

	_, err = io.Copy(file, resp.Body)
	return err
}