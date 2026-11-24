#!/bin/sh
# Update yt-dlp on every start. YouTube changes faster than stable releases.
#   YTDLP_CHANNEL=nightly (default) | master (newest fixes, slightly riskier) | stable
case "${YTDLP_CHANNEL:-nightly}" in
  stable)  pip install --no-cache-dir -U "yt-dlp[default]" || echo "yt-dlp update failed, using the installed version" ;;
  master)  pip install --no-cache-dir -U "yt-dlp[default] @ https://github.com/yt-dlp/yt-dlp/archive/master.tar.gz" || echo "yt-dlp update failed, using the installed version" ;;
  *)       pip install --no-cache-dir -U --pre "yt-dlp[default]" || echo "yt-dlp update failed, using the installed version" ;;
esac
echo "yt-dlp version: $(yt-dlp --version)"
exec node server.js
