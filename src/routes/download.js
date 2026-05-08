const express = require('express');
const router = express.Router();

router.post('/', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const apiUrl = `https://api.tikmate.app/api/lookup`;
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `url=${encodeURIComponent(url)}`
    });
    const data = await response.json();

    res.json({
      success: true,
      video: {
        title: data.desc,
        author: '@' + data.author_name,
        thumbnail: data.cover,
        mp4_url: `https://tikmate.app/download/${data.token}/${data.id}.mp4`,
        mp4_hd_url: `https://tikmate.app/download/${data.token}/${data.id}.mp4?hd=1`,
        mp3_url: `https://tikmate.app/download/${data.token}/${data.id}.mp3`,
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
