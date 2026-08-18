# Frontend build stage
FROM node:22-slim AS frontend-builder
WORKDIR /app/frontend

# Copy package files first to leverage layer caching
COPY src/frontend/package.json src/frontend/yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000

# Copy all frontend files
COPY src/frontend/ ./

# Build the frontend. NODE_OPTIONS bumps V8's old-space cap from ~1.6 GB to 2 GB
# so Vite can bundle on low-RAM hosts (server deployments). It'll spill to swap
# if physical RAM is tight, which is slow but finishes.
ENV NODE_OPTIONS=--max-old-space-size=2048
RUN yarn build

# Backend stage
FROM python:3.11-slim
WORKDIR /app

# Copy requirements first to leverage layer caching
COPY src/backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy backend files
COPY src/backend .

# Copy built frontend from the frontend-builder stage
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8000/ || exit 1

# Set environment variables
ENV PYTHONUNBUFFERED=1

# Document the port number the container will expose
EXPOSE 8000

# Copy startup script
COPY scripts/startup.sh /app/
RUN chmod +x /app/startup.sh

# Run the startup script
CMD ["/app/startup.sh"]
