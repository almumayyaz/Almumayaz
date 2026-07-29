const path = require('path');

const MAGIC_BYTES = {
  'image/jpeg': [0xFF, 0xD8, 0xFF],
  'image/png': [0x89, 0x50, 0x4E, 0x47],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
  'image/gif': [0x47, 0x49, 0x46],
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
};

const ALLOWED_MIMES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'application/zip',
  'font/woff2', 'font/woff', 'font/ttf', 'font/otf',
  'video/mp4', 'video/webm', 'video/ogg',
  'audio/mpeg', 'audio/ogg', 'audio/wav',
];

const ALLOWED_EXTS = [
  '.jpg', '.jpeg', '.png', '.webp', '.gif',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx',
  '.txt', '.zip',
  '.woff2', '.woff', '.ttf', '.otf',
  '.mp4', '.webm', '.ogg',
  '.mp3', '.wav',
];

const MAX_SIZES = {
  avatar: 2 * 1024 * 1024,
  chatImage: 5 * 1024 * 1024,
  paymentReceipt: 3 * 1024 * 1024,
  subrequestReceipt: 3 * 1024 * 1024,
  lessonPdf: 50 * 1024 * 1024,
  reviewPdf: 50 * 1024 * 1024,
  noteFile: 50 * 1024 * 1024,
  font: 3 * 1024 * 1024,
  chatAttachment: 50 * 1024 * 1024,
};

function checkMagicBytes(buffer, declaredMime) {
  if (declaredMime === 'application/pdf' && buffer.length >= 4) {
    return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
  }
  for (const [mime, magic] of Object.entries(MAGIC_BYTES)) {
    if (mime === declaredMime && buffer.length >= magic.length) {
      return magic.every((b, i) => buffer[i] === b);
    }
  }
  return true;
}

function validateUpload({ buffer, originalName, declaredMime, type } = {}) {
  if (!buffer || buffer.length === 0) {
    return { valid: false, error: 'File is empty' };
  }

  if (!originalName) {
    return { valid: false, error: 'File has no name' };
  }

  const ext = path.extname(originalName).toLowerCase();

  if (type && MAX_SIZES[type] && buffer.length > MAX_SIZES[type]) {
    const maxMB = Math.round(MAX_SIZES[type] / (1024 * 1024));
    return { valid: false, error: `File exceeds maximum size of ${maxMB}MB for ${type}` };
  }

  if (ext && !ALLOWED_EXTS.includes(ext)) {
    return { valid: false, error: `Extension "${ext}" is not allowed` };
  }

  const dangerous = ['.html', '.htm', '.js', '.exe', '.bat', '.sh', '.dll', '.vbs', '.ps1', '.php', '.asp', '.jsp', '.war', '.jar', '.msi', '.reg'];
  if (dangerous.includes(ext)) {
    return { valid: false, error: `File type "${ext}" is not allowed for security reasons` };
  }

  if (declaredMime && !ALLOWED_MIMES.includes(declaredMime) && !declaredMime.startsWith('image/')) {
    return { valid: false, error: `MIME type "${declaredMime}" is not allowed` };
  }

  if (declaredMime && !checkMagicBytes(buffer, declaredMime)) {
    return { valid: false, error: 'File content does not match declared MIME type' };
  }

  return { valid: true, mimeType: declaredMime || 'application/octet-stream', ext };
}

module.exports = { validateUpload, checkMagicBytes, ALLOWED_MIMES, ALLOWED_EXTS, MAX_SIZES };
