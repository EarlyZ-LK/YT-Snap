#!/bin/sh
# Update yt-dlp on every start. Nightly is the default because YouTube changes faster than stable releases.
# Set YTDLP_CHANNEL=stable in .env to use stable builds instead.
if [ "${YTDLP_CHANNEL:-nightly}" = "stable" ]; then
  pip install --no-cache-dir -U "yt-dlp[default]" || echo "yt-dlp update failed, using the installed version"
else
  pip install --no-cache-dir -U --pre "yt-dlp[default]" || echo "yt-dlp update failed, using the installed version"
fi
echo "yt-dlp version: $(yt-dlp --version)"
exec node server.js
