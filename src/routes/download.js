const express = require('express');
const router = express.Router();
const { execFileSync, spawn } = require('child_process');

const IMPERSONATE_TARGETS = ['Chrome-133', 'Chrome-124', 'Safari-18.4'];

// ── GET /download/stream?url=...&format=sd|hd|mp3
// Pipes yt-dlp stdout directly to the client, avoiding expiring CDN URLs.
router.get('/stream', (req, res) => {
  const { url, format } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const args = [
    '-m', 'yt_dlp',
    '--impersonate', 'Chrome-133',
    '--no-playlist',
    '-o', '-',
  ];

  if (format === 'mp3') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else if (format === 'hd') {
    args.push('-f', 'bytevc1_1080p/bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best');
  } else {
    args.push('-f', 'h264_540p/bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best');
  }

  // URL must come after all flags
  args.push(url);

  res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="video.${format === 'mp3' ? 'mp3' : 'mp4'}"`);

  const proc = spawn('python3', args);
  proc.stdout.pipe(res);
  proc.stderr.on('data', () => {});
  proc.on('error', () => res.status(500).end());

  // Kill yt-dlp if the client disconnects mid-stream
  res.on('close', () => proc.kill());
});

// ── POST /download
// Returns stream URLs instead of direct (expiring) TikTok CDN URLs.
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

      const data = JSON.parse(raw);
      const formats = data.formats || [];

      const hdFormat = formats
        .filter(f => f.vcodec !== 'none' && f.height)
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

      const encoded = encodeURIComponent(url);

      return res.json({
        success: true,
        video: {
          title:      data.description || data.title,
          author:     '@' + (data.uploader || ''),
          thumbnail:  data.thumbnail,
          duration:   data.duration,
          view_count: data.view_count,
          like_count: data.like_count,
          mp4_url:    `/download/stream?url=${encoded}&format=sd`,
          mp4_hd_url: `/download/stream?url=${encoded}&format=hd`,
          mp3_url:    `/download/stream?url=${encoded}&format=mp3`,
          width:      hdFormat?.width,
          height:     hdFormat?.height,
        }
      });
    } catch (e) {
      const msg = (e.stderr?.toString() || e.message || '').toLowerCase();

      if (msg.includes('log in') || msg.includes('login') || msg.includes('age-restricted')) {
        return res.status(403).json({
          error: 'This video requires login. Try a different video.'
        });
      }

      // Try next impersonation target
    }
  }

  res.status(500).json({ error: 'Could not download this video. Please try again.' });
});

module.exports = router;
