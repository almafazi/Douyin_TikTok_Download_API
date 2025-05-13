FROM golang:1.23-alpine AS builder

# Install build dependencies
RUN apk add --no-cache gcc musl-dev

# Set working directory
WORKDIR /app

# Copy go.mod
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build application
RUN CGO_ENABLED=1 GOOS=linux go build -o downloader

# Runtime stage
FROM alpine:latest

# Install ffmpeg and other runtime dependencies
RUN apk add --no-cache ffmpeg ca-certificates

# Set working directory
WORKDIR /app

# Copy binary from builder stage
COPY --from=builder /app/downloader .

# Create temp directory
RUN mkdir -p temp && chmod 777 temp

# Expose the port
EXPOSE 6075

# Run the application
CMD ["/app/downloader"]