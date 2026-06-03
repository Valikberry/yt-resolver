#!/bin/bash
if ! which ffmpeg; then
  apt-get update && apt-get install -y ffmpeg
fi
if [ ! -f ./yt-dlp ]; then
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ./yt-dlp &
  chmod +x ./yt-dlp 2>/dev/null || true
fi
node server.js
