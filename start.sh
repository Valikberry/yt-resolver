#!/bin/bash
set -e
if [ ! -f ./yt-dlp ]; then
  echo "Downloading yt-dlp..."
  curl -L --output yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
  chmod +x ./yt-dlp
  echo "yt-dlp ready"
fi
echo "Starting server..."
node server.js
