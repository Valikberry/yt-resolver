#!/bin/bash
node download-ytdlp.js
if ! which ffmpeg; then
  apt-get update && apt-get install -y ffmpeg
fi
node server.js
