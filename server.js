const fs = require('fs')
const path = require('path')
const os = require('os')
const express = require('express')
const { execFile } = require('child_process')

const app = express()
const port = process.env.PORT || 3000

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})
app.use(express.json())
app.use(express.raw({ type: 'video/mp4', limit: '100mb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/resolve', (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
  if (!url) { res.status(400).json({ success: false, error: 'url is required' }); return }
  execFile('./yt-dlp', ['-j', '--js-runtimes', 'nodejs', url], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) { res.status(400).json({ success: false, error: stderr || error.message }); return }
    try {
      const data = JSON.parse(stdout)
      const resolvedUrl = data.url || (Array.isArray(data.formats) && data.formats.length ? data.formats[data.formats.length - 1].url : url)
      res.json({ success: true, resolved_url: resolvedUrl, title: data.title || '', duration: data.duration || 0 })
    } catch { res.status(500).json({ success: false, error: 'Failed to parse yt-dlp output' }) }
  })
})


async function downloadVideoUrl(url) {
  const rapidApiKey = process.env.RAPIDAPI_KEY
  if (!rapidApiKey) throw new Error('RAPIDAPI_KEY not set')
  
  const host = 'social-media-video-downloader.p.rapidapi.com'
  let apiUrl
  
  if (url.includes('tiktok.com')) {
    apiUrl = 'https://' + host + '/tiktok/v3/post/details?url=' + encodeURIComponent(url)
  } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
    const shortMatch = url.match(/shorts\/([a-zA-Z0-9_-]+)/)
    const watchMatch = url.match(/[?&]v=([a-zA-Z0-9_-]+)/)
    const videoId = shortMatch ? shortMatch[1] : watchMatch ? watchMatch[1] : null
    if (!videoId) throw new Error('Could not extract YouTube video ID')
    apiUrl = 'https://' + host + '/youtube/v3/video/details?videoId=' + videoId + '&urlAccess=proxied'
  } else if (url.includes('instagram.com')) {
    const scMatch = url.match(/\/(?:p|reel|tv)\/([a-zA-Z0-9_-]+)/)
    if (!scMatch) throw new Error('Could not extract Instagram shortcode')
    apiUrl = 'https://' + host + '/instagram/v3/media/post/details?shortcode=' + scMatch[1]
  } else if (url.includes('facebook.com')) {
    apiUrl = 'https://' + host + '/facebook/v3/post/details?url=' + encodeURIComponent(url)
  } else {
    throw new Error('Unsupported platform. Supported: TikTok, YouTube, Instagram, Facebook')
  }

  const res = await fetch(apiUrl, {
    headers: {
      'x-rapidapi-key': rapidApiKey,
      'x-rapidapi-host': host
    }
  })
  
  const data = await res.json()
  if (data.error) throw new Error('RapidAPI error: ' + JSON.stringify(data.error))
  
  const contents = data.contents?.[0]
  if (!contents) throw new Error('No contents in RapidAPI response')
  
  // Get best MP4 video URL with audio - prefer h264, portrait if available
  const videos = contents.videos || []
  const sorted = videos
    .filter(v => v.metadata?.has_audio && v.metadata?.mime_type?.includes('mp4'))
    .sort((a, b) => (b.metadata?.content_length || 0) - (a.metadata?.content_length || 0))
  
  if (sorted.length === 0) {
    // Try renderableVideos
    const renderable = contents.renderableVideos?.[0]
    if (renderable) return { type: 'renderable', config: renderable.renderConfig }
    throw new Error('No downloadable video found')
  }
  
  return { type: 'direct', url: sorted[0].url }
}

async function convertAndUpload(inputBuffer) {
  const tmpInput = path.join(os.tmpdir(), 'input_' + Date.now() + '.mp4')
  const tmpOutput = path.join(os.tmpdir(), 'output_' + Date.now() + '.mp4')
  fs.writeFileSync(tmpInput, inputBuffer)
  await new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-i', tmpInput,
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart',
      '-t', '60',
      '-y', tmpOutput
    ], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('ffmpeg: ' + stderr.slice(-300)))
      resolve()
    })
  })
  const convertedBytes = fs.readFileSync(tmpOutput)
  fs.unlinkSync(tmpInput)
  fs.unlinkSync(tmpOutput)
  const fileName = 'video_' + Date.now() + '.mp4'
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY
  if (!supabaseUrl || !supabaseKey) throw new Error('Supabase env vars not set')
  const uploadRes = await fetch(supabaseUrl + '/storage/v1/object/video-files/' + fileName, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + supabaseKey, 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
    body: convertedBytes
  })
  if (!uploadRes.ok) { const err = await uploadRes.text(); throw new Error('Supabase upload failed: ' + err) }
  return { storage_path: fileName, file_size: convertedBytes.length }
}

app.post('/prepare-upload', async (req, res) => {
  try {
    const videoBytes = req.body
    if (!videoBytes || !videoBytes.length) return res.status(400).json({ success: false, error: 'No video bytes received' })
    const result = await convertAndUpload(videoBytes)
    res.json({ success: true, ...result })
  } catch (e) { res.status(500).json({ success: false, error: e.message }) }
})

app.post('/prepare-video', async (req, res) => {
  const { video_url } = req.body || {}
  if (!video_url) return res.status(400).json({ success: false, error: 'video_url is required' })
  try {
    const resolvedUrl = await new Promise((resolve, reject) => {
      execFile('./yt-dlp', ['-j', '--js-runtimes', 'nodejs', '--format', 'worst[ext=mp4]/worst', video_url], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message))
        try {
          const data = JSON.parse(stdout)
          const url = data.url || (Array.isArray(data.formats) && data.formats.length ? data.formats[data.formats.length - 1].url : null)
          if (!url) return reject(new Error('No resolved URL'))
          resolve(url)
        } catch (e) { reject(new Error('Failed to parse yt-dlp output')) }
      })
    })
    const videoResponse = await fetch(resolvedUrl)
    if (!videoResponse.ok) throw new Error('Failed to fetch video: ' + videoResponse.status)
    const videoBytes = Buffer.from(await videoResponse.arrayBuffer())
    if (!videoBytes.length) throw new Error('Empty video')
    const result = await convertAndUpload(videoBytes)
    res.json({ success: true, ...result })
  } catch (e) { res.status(500).json({ success: false, error: e.message }) }
})

app.post('/fire-story', async (req, res) => {
  const { storage_path, fb_page_id, token } = req.body || {}
  if (!storage_path || !fb_page_id || !token) return res.status(400).json({ success: false, error: 'storage_path, fb_page_id and token are required' })
  try {
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY
    const fileRes = await fetch(supabaseUrl + '/storage/v1/object/video-files/' + storage_path, {
      headers: { 'Authorization': 'Bearer ' + supabaseKey }
    })
    if (!fileRes.ok) throw new Error('Failed to fetch from Supabase: ' + fileRes.status)
    const videoBytes = await fileRes.arrayBuffer()
    const startParams = new URLSearchParams()
    startParams.append('upload_phase', 'start')
    startParams.append('file_size', String(videoBytes.byteLength))
    startParams.append('access_token', token)
    const startRes = await fetch('https://graph.facebook.com/v21.0/' + encodeURIComponent(fb_page_id) + '/video_stories', { method: 'POST', body: startParams })
    const startJson = await startRes.json()
    if (startJson.error) throw new Error('FB start: ' + JSON.stringify(startJson.error))
    const videoId = startJson.video_id || startJson.id
    const uploadUrl = startJson.upload_url
    if (!videoId || !uploadUrl) throw new Error('Missing video_id or upload_url: ' + JSON.stringify(startJson))
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: { Authorization: 'OAuth ' + token, 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-' + (videoBytes.byteLength - 1) + '/' + videoBytes.byteLength, 'offset': '0', 'file_size': String(videoBytes.byteLength) },
      body: videoBytes
    })
    if (!uploadRes.ok) { const body = await uploadRes.text(); throw new Error('Upload failed (' + uploadRes.status + '): ' + body.slice(0, 300)) }
    const finishParams = new URLSearchParams()
    finishParams.append('upload_phase', 'finish')
    finishParams.append('video_id', videoId)
    finishParams.append('access_token', token)
    const finishRes = await fetch('https://graph.facebook.com/v21.0/' + encodeURIComponent(fb_page_id) + '/video_stories', { method: 'POST', body: finishParams })
    const finishJson = await finishRes.json()
    if (finishJson.error) throw new Error('FB finish: ' + JSON.stringify(finishJson.error))
    await fetch(supabaseUrl + '/storage/v1/object/video-files/' + storage_path, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + supabaseKey } })
    res.json({ success: true, video_id: videoId, result: finishJson })
  } catch (e) { res.status(500).json({ success: false, error: e.message }) }
})


const jobs = {}

async function setJobStatus(job_id, data) {
  jobs[job_id] = data
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY
  if (!supabaseUrl || !supabaseKey) return
  await fetch(supabaseUrl + '/rest/v1/video_jobs', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + supabaseKey,
      'apikey': supabaseKey,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ job_id, ...data, updated_at: new Date().toISOString() })
  }).catch(() => {})
}

async function getJobStatus(job_id) {
  if (jobs[job_id]) return jobs[job_id]
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY
  if (!supabaseUrl || !supabaseKey) return null
  const res = await fetch(supabaseUrl + '/rest/v1/video_jobs?job_id=eq.' + job_id + '&select=*', {
    headers: { 'Authorization': 'Bearer ' + supabaseKey, 'apikey': supabaseKey }
  }).catch(() => null)
  if (!res || !res.ok) return null
  const rows = await res.json().catch(() => [])
  return rows[0] || null
}

app.post('/prepare-async', async (req, res) => {
  const { url, job_id } = req.body || {}
  if (!url || !job_id) return res.status(400).json({ success: false, error: 'url and job_id required' })
  
  await setJobStatus(job_id, { status: 'processing' })
  res.json({ success: true, job_id, status: 'processing' })
  
  try {
    const resolvedUrl = await new Promise((resolve, reject) => {
      execFile('./yt-dlp', ['-j', '--format', 'worst[ext=mp4]/worst', url], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message))
        try {
          const data = JSON.parse(stdout)
          const u = data.url || (Array.isArray(data.formats) && data.formats.length ? data.formats[data.formats.length - 1].url : null)
          if (!u) return reject(new Error('No resolved URL'))
          resolve(u)
        } catch (e) { reject(e) }
      })
    })
    const videoRes = await fetch(resolvedUrl)
    if (!videoRes.ok) throw new Error('Failed to fetch video: ' + videoRes.status)
    const bytes = Buffer.from(await videoRes.arrayBuffer())
    if (!bytes.length) throw new Error('Empty video')
    const result = await convertAndUpload(bytes)
    await setJobStatus(job_id, { status: 'done', ...result })
  } catch (e) {
    await setJobStatus(job_id, { status: 'error', error: e.message })
  }
})

app.get('/job-status/:job_id', async (req, res) => {
  const job = await getJobStatus(req.params.job_id)
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' })
  res.json({ success: true, ...job })
})

app.listen(port, () => { console.log('yt-resolver listening on ' + port) })

app.post('/prepare-from-url', async (req, res) => {
  const { url } = req.body || {}
  if (!url) return res.status(400).json({ success: false, error: 'url is required' })
  try {
    const result = await convertAndUpload(await new Promise((resolve, reject) => {
      execFile('./yt-dlp', ['-j', '--js-runtimes', 'nodejs', '--format', 'worst[ext=mp4]/worst', url], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, async (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message))
        try {
          const data = JSON.parse(stdout)
          const resolvedUrl = data.url || (Array.isArray(data.formats) && data.formats.length ? data.formats[data.formats.length - 1].url : null)
          if (!resolvedUrl) return reject(new Error('No resolved URL'))
          const videoRes = await fetch(resolvedUrl)
          if (!videoRes.ok) return reject(new Error('Failed to fetch video: ' + videoRes.status))
          const bytes = Buffer.from(await videoRes.arrayBuffer())
          if (!bytes.length) return reject(new Error('Empty video'))
          resolve(bytes)
        } catch (e) { reject(e) }
      })
    }))
    res.json({ success: true, ...result })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})
// redeploy Mon May 25 17:19:57 UTC 2026
