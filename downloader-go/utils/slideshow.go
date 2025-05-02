package utils

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// CreateSlideshow creates a slideshow from images and audio
func CreateSlideshow(ctx context.Context, images []string, audioPath, outputPath string) error {
	// Prepare FFmpeg command
	args := []string{}

	// Add input images with loop and duration
	for _, image := range images {
		args = append(args, "-loop", "1", "-t", "3", "-i", image)
	}

	// Add audio with loop
	args = append(args, "-stream_loop", "-1", "-i", audioPath)

	// Build filter complex
	filterComplex := []string{}

	// Scale and pad each image
	for i := range images {
		filterComplex = append(
			filterComplex,
			fmt.Sprintf("[%d:v]scale=w=1080:h=1920:force_original_aspect_ratio=decrease,"+
				"pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v%d]", i, i),
		)
	}

	// Concatenate all scaled/padded video streams
	var concatInputs string
	for i := range images {
		concatInputs += fmt.Sprintf("[v%d]", i)
	}
	filterComplex = append(
		filterComplex,
		fmt.Sprintf("%sconcat=n=%d:v=1:a=0[vout]", concatInputs, len(images)),
	)

	// Calculate the total duration of the video
	videoDuration := len(images) * 3 // 3 seconds per image

	// Add audio filter to trim the looping audio to the video duration
	filterComplex = append(
		filterComplex,
		fmt.Sprintf("[%d:a]atrim=0:%d[aout]", len(images), videoDuration),
	)

	// Add filter complex to args
	args = append(args, "-filter_complex", strings.Join(filterComplex, ";"))

	// Add mapping and output options
	args = append(args,
		"-map", "[vout]",
		"-map", "[aout]",
		"-pix_fmt", "yuv420p",
		"-preset", "medium",
		"-c:v", "libx264",
		"-c:a", "aac",
		"-strict", "experimental",
		"-b:a", "192k",
		"-shortest",
		outputPath,
	)

	// Run FFmpeg command
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("FFmpeg error: %v - %s", err, string(output))
	}

	return nil
}