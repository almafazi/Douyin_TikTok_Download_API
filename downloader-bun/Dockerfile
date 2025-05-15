FROM node:current-bullseye-slim

# Install dependencies for ffmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY . .

# Create temp directory
RUN mkdir -p temp && chmod 777 temp

# Expose the port the app runs on
EXPOSE 6068

# Start the application
CMD ["node", "index.js"]