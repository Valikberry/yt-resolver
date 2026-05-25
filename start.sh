#!/bin/bash
node download-ytdlp.js
if ! which ffmpeg; then
  apt-get update && apt-get install -y ffmpeg
fi
./yt-dlp --update-to nightly 2>/dev/null || true
node server.js
