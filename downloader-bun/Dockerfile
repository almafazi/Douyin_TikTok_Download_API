FROM node:20-slim

# Install dependencies for ffmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Create temp directory
RUN mkdir -p temp && chmod 777 temp

# Expose the port the app runs on
EXPOSE 6068

# Start the application
CMD ["node", "index.js"]