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

  const videos = contents.videos || []
  const sorted = videos
    .filter(v => v.metadata?.has_audio && v.metadata?.mime_type?.includes('mp4') && v.metadata?.CodecType !== 'h265_hvc1')
    .sort((a, b) => (a.metadata?.content_length || 0) - (b.metadata?.content_length || 0))

  const sizeFiltered = sorted.filter(v => (v.metadata?.content_length || 0) < 2000000)
  const finalList = sizeFiltered.length > 0 ? sizeFiltered : sorted
  if (finalList.length === 0) throw new Error('No downloadable video found')

  const video = finalList[0]
  const isPortrait = (video.metadata?.height || 0) > (video.metadata?.width || 0)
  return { url: video.url, isPortrait }
}

async function convertAndUpload(inputBuffer, isPortrait) {
  let finalBuffer = inputBuffer

  if (!isPortrait || inputBuffer.length > 1000000) {
    // Re-encode landscape videos and any video larger than 1MB for Facebook compatibility
    const tmpInput = path.join(os.tmpdir(), 'input_' + Date.now() + '.mp4')
    const tmpOutput = path.join(os.tmpdir(), 'output_' + Date.now() + '.mp4')
    fs.writeFileSync(tmpInput, inputBuffer)

    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-i', tmpInput,
        '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0', '-pix_fmt', 'yuv420p',
        '-vf', 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black',
        '-preset', 'ultrafast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart',
        '-t', '60',
        '-y', tmpOutput
      ], { timeout: 300000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error('ffmpeg: ' + stderr.slice(-300)))
        resolve()
      })
    })

    finalBuffer = fs.readFileSync(tmpOutput)
    fs.unlinkSync(tmpInput)
    fs.unlinkSync(tmpOutput)
  }

  const convertedBytes = finalBuffer

  const fileName = 'video_' + Date.now() + '.mp4'
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY
  if (!supabaseUrl || !supabaseKey) throw new Error('Supabase env vars not set')

  const uploadRes = await fetch(supabaseUrl + '/storage/v1/object/video-files/' + fileName, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + supabaseKey, 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
    body: convertedBytes
  })

  if (!uploadRes.ok) {
    const err = await uploadRes.text()
    throw new Error('Supabase upload failed: ' + err)
  }

  return { storage_path: fileName, file_size: convertedBytes.length }
}

function getImageUrl(candidate) {
  if (!candidate) return null
  if (typeof candidate === 'string') return candidate
  return candidate.url || candidate.src || candidate.image_url || candidate.download_url || candidate.thumbnail || null
}

function getImageScore(candidate) {
  if (!candidate || typeof candidate === 'string') return 0
  const metadata = candidate.metadata || {}
  const width = candidate.width || metadata.width || 0
  const height = candidate.height || metadata.height || 0
  const size = candidate.content_length || metadata.content_length || candidate.size || 0
  return (width * height) || size || 0
}

function collectPinterestImageCandidates(value, pathParts = [], candidates = []) {
  if (!value) return candidates

  if (typeof value === 'string') {
    const lowerValue = value.toLowerCase()
    const pathText = pathParts.join('.').toLowerCase()
    const looksLikeImage = /\.(jpe?g|png|webp)(\?|$)/.test(lowerValue)
    const imagePath = /(image|img|photo|picture|thumbnail|original|media|url)/.test(pathText)
    const looksLikeVideo = /\.(mp4|m3u8|mov)(\?|$)/.test(lowerValue)

    if (value.startsWith('http') && !looksLikeVideo && (looksLikeImage || imagePath)) {
      let score = 1
      if (pathText.includes('original')) score += 1000000000
      if (pathText.includes('large') || pathText.includes('hd')) score += 100000000
      if (pathText.includes('image') || pathText.includes('img')) score += 10000000
      if (pathText.includes('thumbnail')) score -= 1000000
      candidates.push({ url: value, score })
    }
    return candidates
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPinterestImageCandidates(item, pathParts.concat(String(index)), candidates))
    return candidates
  }

  if (typeof value === 'object') {
    const directUrl = getImageUrl(value)
    if (directUrl) {
      candidates.push({
        url: directUrl,
        score: getImageScore(value) + (pathParts.join('.').toLowerCase().includes('thumbnail') ? -1000000 : 0)
      })
    }

    Object.entries(value).forEach(([key, item]) => {
      collectPinterestImageCandidates(item, pathParts.concat(key), candidates)
    })
  }

  return candidates
}

function extractPinterestImageUrl(data) {
  const candidates = collectPinterestImageCandidates(data)
    .filter(candidate => candidate.url)
    .sort((a, b) => b.score - a.score)

  return candidates[0]?.url || null
}

async function downloadImageUrl(url) {
  const rapidApiKey = process.env.RAPIDAPI_KEY
  if (!rapidApiKey) throw new Error('RAPIDAPI_KEY not set')

  let host
  let apiUrl
  let extractImageUrl

  if (url.includes('tiktok.com')) {
    host = 'social-media-video-downloader.p.rapidapi.com'
    apiUrl = 'https://' + host + '/tiktok/v3/post/details?url=' + encodeURIComponent(url)
    extractImageUrl = (data) => {
      const contents = data.contents?.[0]
      if (!contents) throw new Error('No contents in RapidAPI response')

      const images = contents.images || []
      const sorted = images
        .map(image => ({ url: getImageUrl(image), score: getImageScore(image) }))
        .filter(image => image.url)
        .sort((a, b) => b.score - a.score)

      return sorted[0]?.url || getImageUrl(contents.thumbnail)
    }
  } else if (url.includes('pinterest.com') || url.includes('pin.it')) {
    host = 'pinterest-video-and-image-downloader.p.rapidapi.com'
    apiUrl = 'https://' + host + '/pinterest?url=' + encodeURIComponent(url)
    extractImageUrl = extractPinterestImageUrl
  } else {
    throw new Error('Unsupported platform. Supported: TikTok, Pinterest')
  }

  const res = await fetch(apiUrl, {
    headers: {
      'x-rapidapi-key': rapidApiKey,
      'x-rapidapi-host': host
    }
  })

  const data = await res.json()
  if (data.error) throw new Error('RapidAPI error: ' + JSON.stringify(data.error))

  const imageUrl = extractImageUrl(data)
  if (!imageUrl) throw new Error('No downloadable image found')
  return imageUrl
}

async function uploadImage(inputBuffer) {
  const fileName = 'img_' + Date.now() + '.jpg'
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY
  if (!supabaseUrl || !supabaseKey) throw new Error('Supabase env vars not set')

  const uploadRes = await fetch(supabaseUrl + '/storage/v1/object/images/' + fileName, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + supabaseKey, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
    body: inputBuffer
  })

  if (!uploadRes.ok) {
    const err = await uploadRes.text()
    throw new Error('Supabase upload failed: ' + err)
  }

  return supabaseUrl + '/storage/v1/object/public/images/' + fileName
}

app.post('/prepare-from-url', async (req, res) => {
  const { url } = req.body || {}
  if (!url) return res.status(400).json({ success: false, error: 'url is required' })
  try {
    const download = await downloadVideoUrl(url)
    const videoRes = await fetch(download.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://www.tiktok.com/',
        'Accept': '*/*'
      }
    })
    if (!videoRes.ok) throw new Error('Failed to fetch video: ' + videoRes.status)
    const bytes = Buffer.from(await videoRes.arrayBuffer())
    if (!bytes.length) throw new Error('Empty video')
    const isPortrait = download.isPortrait || false
    const result = await convertAndUpload(bytes, isPortrait)
    res.json({ success: true, ...result })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/extract-image', async (req, res) => {
  const { url } = req.body || {}
  if (!url) return res.status(400).json({ success: false, error: 'url is required' })
  try {
    const imageUrl = await downloadImageUrl(url)
    const imageRes = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    })
    if (!imageRes.ok) throw new Error('Failed to fetch image: ' + imageRes.status)
    const bytes = Buffer.from(await imageRes.arrayBuffer())
    if (!bytes.length) throw new Error('Empty image')
    const publicUrl = await uploadImage(bytes)
    res.json({ success: true, image_url: publicUrl })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/fire-story', async (req, res) => {
  const { storage_path, fb_page_id, token } = req.body || {}
  if (!storage_path || !fb_page_id || !token) {
    return res.status(400).json({ success: false, error: 'storage_path, fb_page_id and token are required' })
  }
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
    const startRes = await fetch('https://graph.facebook.com/v21.0/' + encodeURIComponent(fb_page_id) + '/video_stories', {
      method: 'POST', body: startParams
    })
    const startJson = await startRes.json()
    if (startJson.error) throw new Error('FB start: ' + JSON.stringify(startJson.error))
    const videoId = startJson.video_id || startJson.id
    const uploadUrl = startJson.upload_url
    if (!videoId || !uploadUrl) throw new Error('Missing video_id or upload_url')

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: 'OAuth ' + token,
        'Content-Type': 'application/octet-stream',
        'Content-Range': 'bytes 0-' + (videoBytes.byteLength - 1) + '/' + videoBytes.byteLength,
        'offset': '0',
        'file_size': String(videoBytes.byteLength)
      },
      body: videoBytes
    })
    if (!uploadRes.ok) {
      const body = await uploadRes.text()
      throw new Error('Upload failed (' + uploadRes.status + '): ' + body.slice(0, 300))
    }

    const finishParams = new URLSearchParams()
    finishParams.append('upload_phase', 'finish')
    finishParams.append('video_id', videoId)
    finishParams.append('access_token', token)
    const finishRes = await fetch('https://graph.facebook.com/v21.0/' + encodeURIComponent(fb_page_id) + '/video_stories', {
      method: 'POST', body: finishParams
    })
    const finishJson = await finishRes.json()
    if (finishJson.error) throw new Error('FB finish: ' + JSON.stringify(finishJson.error))

    await fetch(supabaseUrl + '/storage/v1/object/video-files/' + storage_path, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + supabaseKey }
    })

    res.json({ success: true, video_id: videoId, result: finishJson })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.listen(port, () => {
  console.log('yt-resolver listening on ' + port)
})
