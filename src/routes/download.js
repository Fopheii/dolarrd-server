const express = require('express');
const router = express.Router();
const { execFileSync } = require('child_process');

router.post('/', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const raw = execFileSync('python3', [
      '-m', 'yt_dlp',
      '--dump-json',
      '--no-playlist',
      '--impersonate', 'Chrome-133',
      url
    ], { timeout: 30000 }).toString();

    const data = JSON.parse(raw);
    const formats = data.formats || [];

    // Best HD format (highest quality, no watermark)
    const hdFormat = formats
      .filter(f => f.vcodec !== 'none' && f.height)
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

    // SD format
    const sdFormat = formats
      .filter(f => f.vcodec !== 'none' && f.height)
      .sort((a, b) => (a.height || 0) - (b.height || 0))[0];

    // Audio only
    const audioFormat = formats
      .find(f => f.vcodec === 'none' && f.acodec !== 'none');

    res.json({
      success: true,
      video: {
        title: data.description || data.title,
        author: '@' + (data.uploader || ''),
        thumbnail: data.thumbnail,
        duration: data.duration,
        view_count: data.view_count,
        like_count: data.like_count,
        mp4_url: sdFormat?.url || data.url,
        mp4_hd_url: hdFormat?.url || data.url,
        mp3_url: audioFormat?.url || null,
        width: hdFormat?.width,
        height: hdFormat?.height,
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
