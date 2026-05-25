#!/bin/bash
node download-ytdlp.js
which ffmpeg || apt-get install -y ffmpeg
node server.js
