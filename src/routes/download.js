const express = require('express');
const router = express.Router();
const { execFileSync } = require('child_process');

const IMPERSONATE_TARGETS = ['Chrome-133', 'Chrome-124', 'Safari-18.4'];

function buildResponse(data) {
  const formats = data.formats || [];

  const hdFormat = formats
    .filter(f => f.vcodec !== 'none' && f.height)
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

  const sdFormat = formats
    .filter(f => f.vcodec !== 'none' && f.height)
    .sort((a, b) => (a.height || 0) - (b.height || 0))[0];

  const audioFormat = formats
    .find(f => f.vcodec === 'none' && f.acodec !== 'none');

  return {
    success: true,
    video: {
      title:      data.description || data.title,
      author:     '@' + (data.uploader || ''),
      thumbnail:  data.thumbnail,
      duration:   data.duration,
      view_count: data.view_count,
      like_count: data.like_count,
      mp4_url:    sdFormat?.url || data.url,
      mp4_hd_url: hdFormat?.url || data.url,
      mp3_url:    audioFormat?.url || null,
      width:      hdFormat?.width,
      height:     hdFormat?.height,
    }
  };
}

router.post('/', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  for (const target of IMPERSONATE_TARGETS) {
    try {
      const raw = execFileSync('python3', [
        '-m', 'yt_dlp',
        '--dump-json',
        '--no-playlist',
        '--impersonate', target,
        url
      ], { timeout: 30000 }).toString();

      return res.json(buildResponse(JSON.parse(raw)));
    } catch (e) {
      const msg = (e.stderr?.toString() || e.message || '').toLowerCase();

      if (msg.includes('log in') || msg.includes('login') || msg.includes('age-restricted')) {
        return res.status(403).json({
          error: 'This video requires login. Try a different video.'
        });
      }

      // Any other error — try the next impersonation target
    }
  }

  res.status(500).json({ error: 'Could not download this video. Please try again.' });
});

module.exports = router;
