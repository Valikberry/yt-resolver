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
    .filter(v => v.metadata?.has_audio && v.metadata?.mime_type?.includes('mp4'))
    .sort((a, b) => (b.metadata?.content_length || 0) - (a.metadata?.content_length || 0))

  if (sorted.length === 0) throw new Error('No downloadable video found')

  const video = sorted[0]
  const isPortrait = (video.metadata?.height || 0) > (video.metadata?.width || 0)
  return { url: video.url, isPortrait }
}

async function convertAndUpload(inputBuffer, isPortrait, hook, hookColor) {
  let finalBuffer = inputBuffer

  // Burn hook text if provided
  if (hook && hook.trim()) {
    const color = (hookColor || '#FF3B30').replace('#', '')
    const tmpHookInput = path.join(os.tmpdir(), 'hook_input_' + Date.now() + '.mp4')
    const tmpHookOutput = path.join(os.tmpdir(), 'hook_output_' + Date.now() + '.mp4')
    fs.writeFileSync(tmpHookInput, inputBuffer)
    const lines = hook.trim().toUpperCase().split(' ')
    const fade = "if(lt(t,1),1,if(lt(t,2),0.7,if(lt(t,3),0.4,if(lt(t,4),0,0))))"
    const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
    let drawtext
    if (lines.length === 1) {
      drawtext = `drawtext=text='${lines[0]}':fontfile=${font}:fontsize=130:fontcolor=0x${color}:borderw=5:bordercolor=white:x=(w-text_w)/2:y=(h-text_h)/2:alpha='${fade}'`
    } else {
      drawtext = lines.map((line, i) => {
        const y = i === 0 ? '(h/2 - text_h - 10)' : '(h/2 + 10)'
        return `drawtext=text='${line}':fontfile=${font}:fontsize=130:fontcolor=0x${color}:borderw=5:bordercolor=white:x=(w-text_w)/2:y=${y}:alpha='${fade}'`
      }).join(',')
    }
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-i', tmpHookInput,
        '-vf', 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,' + drawtext,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-max_muxing_queue_size', '1024',
        '-t', '60',
        '-y', tmpHookOutput
      ], { timeout: 300000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error('ffmpeg hook: ' + stderr.slice(-300)))
        resolve()
      })
    })
    finalBuffer = fs.readFileSync(tmpHookOutput)
    fs.unlinkSync(tmpHookInput)
    fs.unlinkSync(tmpHookOutput)
  }

  if (!isPortrait) {
    // Only re-encode landscape videos
    const tmpInput = path.join(os.tmpdir(), 'input_' + Date.now() + '.mp4')
    const tmpOutput = path.join(os.tmpdir(), 'output_' + Date.now() + '.mp4')
    fs.writeFileSync(tmpInput, inputBuffer)

    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-i', tmpInput,
        '-vf', 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
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

app.post('/prepare-from-url', async (req, res) => {
  const { url, hook, hookColor } = req.body || {}
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


app.get('/test-ffmpeg', async (req, res) => {
  const { execFile } = require('child_process')
  const path = require('path')
  const os = require('os')
  const tmpOut = path.join(os.tmpdir(), 'test_' + Date.now() + '.mp4')
  execFile('ffmpeg', [
    '-f', 'lavfi', '-i', 'color=c=blue:s=720x1280:d=5',
    '-vf', "drawtext=text='TEST':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=130:fontcolor=red:borderw=5:bordercolor=white:x=(w-text_w)/2:y=(h-text_h)/2",
    '-c:v', 'libx264', '-t', '5', '-y', tmpOut
  ], { timeout: 60000 }, (err, stdout, stderr) => {
    if (err) return res.json({ success: false, error: stderr.slice(-500) })
    const size = require('fs').statSync(tmpOut).size
    require('fs').unlinkSync(tmpOut)
    res.json({ success: true, size })
  })
})

app.listen(port, () => {
  console.log('yt-resolver listening on ' + port)
})
