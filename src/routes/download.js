const express = require('express');
const router = express.Router();

// tikmate API returns: { success, id, token, desc, cover }
// There is no author field — extract @username from the TikTok URL path.
function authorFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/\/@([^/]+)/);
    return match ? '@' + match[1] : null;
  } catch {
    return null;
  }
}

router.post('/', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const response = await fetch('https://api.tikmate.app/api/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `url=${encodeURIComponent(url)}`
    });
    const data = await response.json();

    if (!data.success) {
      return res.status(422).json({ error: data.message || 'Could not process this video.' });
    }

    res.json({
      success: true,
      video: {
        title: data.desc,
        author: authorFromUrl(url),
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
