#!/bin/bash
apt-get update -qq && apt-get install -y ffmpeg python3-pip -qq
python3 -m pip install yt-dlp --break-system-packages -q
ln -sf $(which yt-dlp) /app/yt-dlp 2>/dev/null || true
node server.js
