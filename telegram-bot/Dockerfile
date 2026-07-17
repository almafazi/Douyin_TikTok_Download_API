FROM node:20-alpine AS builder

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install exactly the dependency versions recorded in package-lock.json.
# Using npm ci prevents npm from unexpectedly resolving optional native modules
# (such as canvas) that are not part of this application.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Copy source code
COPY . .

# Production stage
FROM node:20-alpine AS production

# Install wget for the container health check and create the runtime user.
RUN apk add --no-cache wget && \
    addgroup -g 1001 -S nodejs && \
    adduser -S botuser -u 1001 -G nodejs

# Create app directory
WORKDIR /app

# Copy package files
COPY --chown=botuser:nodejs package*.json ./

# Copy production dependencies from builder.
COPY --chown=botuser:nodejs --from=builder /app/node_modules ./node_modules

# Copy app source from builder
COPY --chown=botuser:nodejs --from=builder /app/bot.js ./
COPY --chown=botuser:nodejs --from=builder /app/server.js ./
COPY --chown=botuser:nodejs --from=builder /app/healthcheck.js ./
COPY --chown=botuser:nodejs --from=builder /app/utils ./utils
COPY --chown=botuser:nodejs --from=builder /app/analytics ./analytics
COPY --chown=botuser:nodejs --from=builder /app/miniapp ./miniapp

USER botuser

# Expose ports for health checks, webhooks, and dashboard
EXPOSE 3000 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost:3000/health || exit 1

# Start the bot
CMD ["node", "bot.js"]
