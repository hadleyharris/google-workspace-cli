FROM node:22-slim

WORKDIR /app

# Install gws CLI globally
RUN npm install -g @googleworkspace/cli

# Create data dir for token persistence (mount a Render disk here)
RUN mkdir -p /data

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
