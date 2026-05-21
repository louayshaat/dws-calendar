# =============================================================================
# Multi-stage Dockerfile
# Stage 1: Build the React frontend (Vite)
# Stage 2: Production Node.js image that serves both the API and static files
# =============================================================================

# ── Stage 1: Build React frontend ────────────────────────────────────────────
FROM node:20-alpine AS frontend-build

WORKDIR /app/client

# Copy manifest(s) first for layer caching.
# Using package.json only (no lock file required).
COPY client/package.json ./
RUN npm install

# Copy the rest of the frontend source and build it
COPY client/ ./
RUN npm run build
# Output: /app/client/dist


# ── Stage 2: Production server ───────────────────────────────────────────────
FROM node:20-alpine AS server

WORKDIR /app

# Install only backend production deps
COPY package.json ./
RUN npm install --omit=dev

# Copy the Express server
COPY server.js ./

# Copy the compiled React app from Stage 1 into the public folder
COPY --from=frontend-build /app/client/dist ./public

# Cloud Run sets PORT automatically; default to 8080
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.js"]
