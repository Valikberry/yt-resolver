#!/bin/bash
if ! which ffmpeg; then
  apt-get update && apt-get install -y ffmpeg
fi
pip3 install yt-dlp --break-system-packages -q 2>/dev/null || python3 -m pip install yt-dlp --break-system-packages -q
ln -sf $(which yt-dlp) ./yt-dlp 2>/dev/null || true
node server.js
