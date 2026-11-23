FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Install yt-dlp with pip so the EJS challenge-solver scripts come with it ("[default]"); Node is the JS runtime.
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -U "yt-dlp[default]"
ENV PATH="/opt/venv/bin:${PATH}"
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dependencies
COPY . .
ENV NODE_ENV=production DATA_DIR=/data
VOLUME /data
EXPOSE 3000
# YouTube changes often, so update yt-dlp (and its solver scripts) on every start
CMD ["sh", "-c", "pip install --no-cache-dir -U 'yt-dlp[default]' || true; node server.js"]
