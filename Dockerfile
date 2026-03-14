FROM node:22

WORKDIR /app

# Install gws CLI globally
RUN npm install -g @googleworkspace/cli

# Create data dir for token persistence
RUN mkdir -p /data

# Ensure Rust binary can find system CA certs
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_DIR=/etc/ssl/certs

# Copy package files and install deps
COPY package.json package-lock.json* ./
RUN npm install

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

ENV PORT=3000
ENV DATA_DIR=/data
EXPOSE 3000

CMD ["node", "dist/index.js"]
