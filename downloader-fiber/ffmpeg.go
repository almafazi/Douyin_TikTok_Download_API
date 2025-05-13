package main

import (
	"fmt"
	"log"
	"os/exec"
	"strings"
)

// createSlideshow creates a slideshow from images and audio
func createSlideshow(imagePaths []string, audioPath, outputPath string) error {
	log.Printf("Creating slideshow with %d images", len(imagePaths))
	
	// Build FFmpeg command
	args := []string{"-y"} // Overwrite output if exists
	
	// Add each image as input
	for _, imagePath := range imagePaths {
		args = append(args, "-loop", "1", "-t", "4", "-i", imagePath)
	}
	
	// Add audio with loop
	args = append(args, "-stream_loop", "-1", "-i", audioPath)
	
	// Build complex filter for scaling and concatenating images
	filterComplex := ""
	
	// Scale and pad each image
	for i := range imagePaths {
		filterComplex += fmt.Sprintf("[%d:v]scale=w=1080:h=1920:force_original_aspect_ratio=decrease,"+
			"pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v%d];", i, i)
	}
	
	// Concatenate all scaled/padded video streams
	concatInputs := ""
	for i := range imagePaths {
		concatInputs += fmt.Sprintf("[v%d]", i)
	}
	filterComplex += fmt.Sprintf("%sconcat=n=%d:v=1:a=0[vout];", concatInputs, len(imagePaths))
	
	// Calculate total duration
	videoDuration := len(imagePaths) * 4
	
	// Add audio filter to trim the looping audio to the video duration
	filterComplex += fmt.Sprintf("[%d:a]atrim=0:%d[aout]", len(imagePaths), videoDuration)
	
	// Add filter complex to args
	args = append(args, "-filter_complex", filterComplex)
	
	// Map outputs
	args = append(args, 
		"-map", "[vout]", 
		"-map", "[aout]",
		"-pix_fmt", "yuv420p",
		"-fps_mode", "cfr")
	
	// Set video codec
	args = append(args, "-c:v", "libx264")
	
	// Add output file
	args = append(args, outputPath)
	
	// Create command
	cmd := exec.Command("ffmpeg", args...)
	
	// Get command as string for logging
	//cmdStr := fmt.Sprintf("ffmpeg %s", strings.Join(args, " "))
	// log.Printf("Running FFmpeg command: %s", cmdStr)
	
	// Run command
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("FFmpeg error: %v\nOutput: %s", err, string(output))
		return fmt.Errorf("FFmpeg error: %v", err)
	}
	
	log.Printf("Slideshow created successfully at %s", outputPath)
	return nil
}