FROM node:20-alpine

# Install dependencies for native modules
RUN apk add --no-cache python3 make g++

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy app source
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S botuser -u 1001

# Change ownership
RUN chown -R botuser:nodejs /app
USER botuser

# Expose port (if needed for health checks)
EXPOSE 3000

# Start the bot
CMD ["node", "bot.js"]
