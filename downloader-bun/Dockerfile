FROM oven/bun:latest

# Install dependencies for ffmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package.json
COPY package.json ./

# Install dependencies using Bun
RUN bun install --frozen-lockfile --production

# Copy application code
COPY . .

# Create temp directory
RUN mkdir -p temp && chmod 777 temp

# Expose the port the app runs on
EXPOSE 6068

# Start the application with Bun
CMD ["bun", "run", "index.js"]