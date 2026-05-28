#!/bin/bash
if ! which ffmpeg; then
  apt-get update && apt-get install -y ffmpeg
fi
node server.js
