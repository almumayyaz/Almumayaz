/**
 * YouTube utility: extract video ID from any YouTube URL format,
 * and build fully-parameterised embed URLs.
 */

const YT_ID_PATTERNS = [
  /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/|live\/))([a-zA-Z0-9_-]{11})/i,
  /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/i,
  /[?&]v=([a-zA-Z0-9_-]{11})/i,
  /src=["']https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([a-zA-Z0-9_-]{11})/i
];

/**
 * extractYouTubeId(input)
 * Returns 11-char video ID or null.
 * Handles: watch?v=, youtu.be/, /embed/, /shorts/, youtube-nocookie, full iframe src.
 */
function extractYouTubeId(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  for (const re of YT_ID_PATTERNS) {
    const m = s.match(re);
    if (m && m[1]) return m[1];
  }
  const idMatch = s.match(/([a-zA-Z0-9_-]{11})/);
  return idMatch ? idMatch[1] : null;
}

/**
 * buildEmbedUrl(videoId, origin)
 * Returns full YouTube embed URL with all required parameters,
 * or null if videoId is invalid.
 */
function buildEmbedUrl(videoId, origin) {
  if (!videoId || typeof videoId !== 'string') return null;
  const id = videoId.trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return null;
  const base = 'https://www.youtube.com/embed/' + encodeURIComponent(id);
  const params = [
    'enablejsapi=1',
    'playsinline=1',
    'rel=0',
    'modestbranding=1',
    'showinfo=0',
    'iv_load_policy=3',
    'origin=' + encodeURIComponent(origin || ''),
    'autoplay=0',
    'controls=1',
    'fs=1',
    'disablekb=0'
  ];
  return base + '?' + params.join('&');
}

module.exports = { extractYouTubeId, buildEmbedUrl };
