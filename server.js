const fs = require('fs')
const path = require('path')
const os = require('os')
const express = require('express')
const { execFile } = require('child_process')

const app = express()
const port = process.env.PORT || 3000

app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/resolve', (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
  if (!url) {
    res.status(400).json({ success: false, error: 'url is required' })
    return
  }
  execFile('./yt-dlp', ['-j', url], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      res.status(400).json({ success: false, error: stderr || error.message })
      return
    }
    try {
      const data = JSON.parse(stdout)
      const resolvedUrl = data.url || (Array.isArray(data.formats) && data.formats.length ? data.formats[data.formats.length - 1].url : url)
      res.json({ success: true, resolved_url: resolvedUrl, title: data.title || '', duration: data.duration || 0 })
    } catch {
      res.status(500).json({ success: false, error: 'Failed to parse yt-dlp output' })
    }
  })
})

app.listen(port, () => {
  console.log(`yt-resolver listening on ${port}`)
})

app.post('/fire-story', async (req, res) => {
  const { video_url, fb_page_id, token } = req.body || {}
  if (!video_url || !fb_page_id || !token) {
    return res.status(400).json({ success: false, error: 'video_url, fb_page_id and token are required' })
  }
  try {
    const resolveResult = await new Promise((resolve, reject) => {
      execFile('./yt-dlp', ['-j', video_url], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message))
        try {
          const data = JSON.parse(stdout)
          const resolved = data.url || (Array.isArray(data.formats) && data.formats.length ? data.formats[data.formats.length - 1].url : null)
          if (!resolved) return reject(new Error('No resolved URL from yt-dlp'))
          resolve(resolved)
        } catch (e) { reject(new Error('Failed to parse yt-dlp output')) }
      })
    })

    const videoResponse = await fetch(resolveResult)
    if (!videoResponse.ok) throw new Error(`Failed to fetch video (${videoResponse.status})`)
    const videoBytes = await videoResponse.arrayBuffer()

    // Convert to 9:16 portrait 1080x1920 using ffmpeg
    const tmpInput = path.join(os.tmpdir(), `input_${Date.now()}.mp4`)
    const tmpOutput = path.join(os.tmpdir(), `output_${Date.now()}.mp4`)
    fs.writeFileSync(tmpInput, Buffer.from(videoBytes))
    
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-i', tmpInput,
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', tmpOutput
      ], { timeout: 300000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error('ffmpeg failed: ' + stderr))
        resolve()
      })
    })
    
    const convertedBytes = fs.readFileSync(tmpOutput)
    fs.unlinkSync(tmpInput)
    fs.unlinkSync(tmpOutput)

    const startParams = new URLSearchParams()
    startParams.append('upload_phase', 'start')
    startParams.append('file_size', String(convertedBytes.length))
    startParams.append('access_token', token)
    const startRes = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(fb_page_id)}/video_stories`, {
      method: 'POST', body: startParams
    })
    const startJson = await startRes.json()
    if (startJson.error) throw new Error(`FB start error: ${JSON.stringify(startJson.error)}`)
    const videoId = startJson.video_id || startJson.id
    const uploadUrl = startJson.upload_url
    if (!videoId || !uploadUrl) throw new Error(`Missing video_id or upload_url: ${JSON.stringify(startJson)}`)

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: { Authorization: `OAuth ${token}`, 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes 0-${convertedBytes.length - 1}/${convertedBytes.length}`, 'offset': '0', 'file_size': String(convertedBytes.length) },
      body: convertedBytes
    })
    const uploadBody = await uploadRes.text(); if (!uploadRes.ok) throw new Error(`Upload failed (${uploadRes.status}): ${uploadBody.slice(0, 300)}`)

    const finishParams = new URLSearchParams()
    finishParams.append('upload_phase', 'finish')
    finishParams.append('video_id', videoId)
    finishParams.append('access_token', token)
    const finishRes = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(fb_page_id)}/video_stories`, {
      method: 'POST', body: finishParams
    })
    const finishJson = await finishRes.json()
    if (finishJson.error) throw new Error(`FB finish error: ${JSON.stringify(finishJson.error)}`)

    res.json({ success: true, video_id: videoId, result: finishJson })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})
// force redeploy Mon May 25 05:45:11 UTC 2026
