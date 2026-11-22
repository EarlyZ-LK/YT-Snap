FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dependencies
COPY . .
ENV NODE_ENV=production DATA_DIR=/data
VOLUME /data
EXPOSE 3000
# YouTube changes often, so update yt-dlp on every start
CMD ["sh", "-c", "yt-dlp -U || true; node server.js"]
