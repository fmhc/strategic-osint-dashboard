# Multi-stage build for smaller production image
FROM node:22-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Vendor CesiumJS into public/vendor/cesium (self-hosted, no runtime CDN).
# The dir is gitignored, so fetch it at build time to keep the image self-contained.
RUN apk add --no-cache bash curl unzip && \
    bash scripts/fetch-cesium.sh

# Remove any development files and dependencies
RUN npm prune --production && \
    rm -rf .git .vscode docs/ *.md .env.example

# Production stage
FROM node:22-alpine AS production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S osint -u 1001

# Install runtime dependencies
RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Copy application files from builder
COPY --from=builder --chown=osint:nodejs /app/server.js ./
COPY --from=builder --chown=osint:nodejs /app/modules ./modules/
COPY --from=builder --chown=osint:nodejs /app/public ./public/

# Create data directory with correct permissions
RUN mkdir -p /app/data && chown -R osint:nodejs /app/data

# Set production environment variables
ENV NODE_ENV=production \
    COMPRESSION_LEVEL=2 \
    STATIC_CACHE_MAXAGE=1d \
    OLLAMA_ENABLED=false \
    PORT=3333

# Switch to non-root user
USER osint

# Expose port
EXPOSE 3333

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3333/api/status || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start application
CMD ["node", "server.js"]