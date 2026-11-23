FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# yt-dlp via pip so the EJS challenge-solver scripts ("[default]") come with it; Node is the JS runtime.
# --pre installs the nightly build, which usually has the newest YouTube fixes.
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -U --pre "yt-dlp[default]"
ENV PATH="/opt/venv/bin:${PATH}"
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dependencies
COPY . .
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh
ENV NODE_ENV=production DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["./docker-entrypoint.sh"]
