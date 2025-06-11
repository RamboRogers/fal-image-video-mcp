# Multi-stage build for smaller production image
FROM node:23-slim AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Production stage
FROM node:18-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy built application
COPY --from=builder /app/dist ./dist

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodejs

# Create download directory with proper permissions
RUN mkdir -p /tmp/fal-downloads && chown nodejs:nodejs /tmp/fal-downloads

# Change ownership to nodejs user
RUN chown -R nodejs:nodejs /app
USER nodejs

# Expose port (Smithery will set this via PORT env var)
EXPOSE 3000

# Set default environment for HTTP mode
ENV NODE_ENV=production

# Start the server (will auto-detect HTTP mode when PORT is set)
CMD ["node", "dist/index.js"]