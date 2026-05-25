const https = require('https')
const fs = require('fs')
const { execSync } = require('child_process')

const dest = './yt-dlp'
if (fs.existsSync(dest)) {
  console.log('yt-dlp already exists')
  process.exit(0)
}

console.log('Installing python3...')
try {
  execSync('apt-get install -y python3', { stdio: 'inherit' })
} catch(e) {
  console.log('apt-get failed:', e.message)
}

console.log('Downloading yt-dlp...')
const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'

function download(url, dest, cb) {
  const file = fs.createWriteStream(dest)
  https.get(url, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      file.close()
      fs.unlinkSync(dest)
      download(res.headers.location, dest, cb)
      return
    }
    res.pipe(file)
    file.on('finish', () => { file.close(cb) })
  }).on('error', (err) => {
    fs.unlinkSync(dest)
    cb(err)
  })
}

download(url, dest, (err) => {
  if (err) { console.error('Download failed:', err); process.exit(1) }
  execSync('chmod +x ./yt-dlp')
  console.log('yt-dlp ready')
})
