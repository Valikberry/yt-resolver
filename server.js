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
