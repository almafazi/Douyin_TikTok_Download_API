# Stage 1: Build
FROM golang:1.23-alpine AS builder

# Instalasi dependensi sistem
RUN apk add --no-cache git

# Set working directory
WORKDIR /app

# Copy go.mod dan go.sum
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy kode sumber
COPY . .

# Build aplikasi
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o tikdownloader .

# Stage 2: Run
FROM alpine:latest

# Instalasi dependensi runtime
RUN apk add --no-cache ffmpeg ca-certificates tzdata

# Set timezone ke Asia/Jakarta
ENV TZ=Asia/Jakarta

# Set working directory
WORKDIR /app

# Copy binary dari builder stage
COPY --from=builder /app/tikdownloader .

# Buat direktori untuk file sementara
RUN mkdir -p /app/temp

# Set environment variables
ENV BASE_URL="http://localhost:3021"
ENV PORT="3021"
ENV ENCRYPTION_KEY="overflow"
ENV DOUYIN_API_URL="http://douyin_tiktok_download_api:8000/api/hybrid/video_data"
ENV GIN_MODE="release"

# Expose port yang digunakan aplikasi
EXPOSE 3021

# Command untuk menjalankan aplikasi
CMD ["./tikdownloader"]