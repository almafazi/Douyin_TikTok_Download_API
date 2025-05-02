package models

// TikTokRequest represents the request for TikTok URL processing
type TikTokRequest struct {
	URL string `json:"url" binding:"required"`
}

// DownloadData represents the data encrypted for download links
type DownloadData struct {
	URL    string `json:"url"`
	Author string `json:"author"`
	Type   string `json:"type"`
}

// Author represents the creator of TikTok content
type Author struct {
	Nickname  string `json:"nickname"`
	Signature string `json:"signature,omitempty"`
	Avatar    string `json:"avatar,omitempty"`
}

// Statistics represents engagement metrics for TikTok content
type Statistics struct {
	RepostCount  int `json:"repost_count"`
	CommentCount int `json:"comment_count"`
	DiggCount    int `json:"digg_count"`
	PlayCount    int `json:"play_count"`
}

// PhotoItem represents a single photo in an image gallery
type PhotoItem struct {
	Type string `json:"type"`
	URL  string `json:"url"`
}

// TikTokResponse is the response sent back to the client
type TikTokResponse struct {
	Status            string                 `json:"status"`
	Photos            []PhotoItem            `json:"photos"`
	Title             string                 `json:"title,omitempty"`
	Description       string                 `json:"description,omitempty"`
	Statistics        Statistics             `json:"statistics"`
	Artist            string                 `json:"artist,omitempty"`
	Cover             string                 `json:"cover,omitempty"`
	Duration          int                    `json:"duration"`
	Audio             string                 `json:"audio,omitempty"`
	MusicDuration     int                    `json:"music_duration"`
	Author            Author                 `json:"author"`
	DownloadLink      map[string]interface{} `json:"download_link"`
	SlideshowDownLink string                 `json:"download_slideshow_link,omitempty"`
}