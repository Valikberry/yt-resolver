#!/bin/bash
if ! which ffmpeg; then
  apt-get update && apt-get install -y ffmpeg
fi
pip install yt-dlp --break-system-packages -q
ln -sf $(which yt-dlp) ./yt-dlp 2>/dev/null || true
node server.js
