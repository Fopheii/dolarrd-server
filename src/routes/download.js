const express = require('express');
const router = express.Router();
const { execFileSync } = require('child_process');

router.post('/', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const raw = execFileSync('yt-dlp', [
      '--dump-json',
      '--no-playlist',
      url
    ], { timeout: 30000 }).toString();

    const data = JSON.parse(raw);

    const formats = data.formats || [];
    const hdFormat = formats.filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    const audioFormat = formats.find(f => f.vcodec === 'none' && f.acodec !== 'none');

    res.json({
      success: true,
      video: {
        title: data.description || data.title,
        author: '@' + (data.uploader || data.creator),
        thumbnail: data.thumbnail,
        duration: data.duration,
        mp4_url: data.url,
        mp4_hd_url: hdFormat?.url || data.url,
        mp3_url: audioFormat?.url || null,
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
