# H5P Server Dockerfile
# License: GPL-3.0-or-later (due to @lumieducation/h5p-server dependency)
#
# This container provides an H5P content authoring and playback server
# that can be integrated with any LMS via HTTP API.

FROM node:20.19-alpine

LABEL maintainer="Chris Honselaar"
LABEL description="H5P Content Server for LMS Integration"
LABEL license="GPL-3.0-or-later"

# Create app directory
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY src/ ./src/
COPY scripts/ ./scripts/
# Vietnamese strings the engine applies at runtime: the content-type UI copy the
# player rewrites, and the semantics labels the editor overrides. Without these
# the image silently falls back to English.
COPY translations/ ./translations/
COPY h5p/core/ /opt/h5p-seed/core/
COPY h5p/editor/ /opt/h5p-seed/editor/
COPY seed-libraries/ /opt/h5p-seed/libraries/
# Versioned content type bundle, unpacked into the data volume on first boot so
# a new environment does not have to re-download anything from the H5P Hub.
COPY library-bundles/ /opt/h5p-seed/library-bundles/
COPY docker-entrypoint.sh /usr/local/bin/h5p-entrypoint

# Create directories for H5P data (will be mounted as volumes)
RUN mkdir -p /data/h5p/content /data/h5p/libraries /data/h5p/temp /data/h5p/user-data /data/h5p/core /data/h5p/editor

# Environment variables with sensible defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV H5P_BASE_URL=http://localhost:3000
ENV DJANGO_URL=http://host.docker.internal:8000
ENV H5P_DATA_PATH=/data/h5p

# Expose the server port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider "http://localhost:${PORT:-3000}/health" || exit 1

# Run as non-root user for security
RUN addgroup -g 1001 -S h5p && adduser -u 1001 -S h5p -G h5p
RUN chmod +x /usr/local/bin/h5p-entrypoint && chown -R h5p:h5p /app /data /opt/h5p-seed
USER h5p

ENTRYPOINT ["/usr/local/bin/h5p-entrypoint"]
CMD ["node", "src/index.js"]
