const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain', 'application/zip'
    ];
    if (allowedMimes.includes(file.mimetype) || file.mimetype.startsWith('image/')) {
      return cb(null, true);
    }
    cb(null, false);
  }
});

const fontUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname || '').toLowerCase();
    if (ext.endsWith('.woff2') || ext.endsWith('.woff') || ext.endsWith('.ttf') || ext.endsWith('.otf')) {
      return cb(null, true);
    }
    cb(new Error('Only font files are allowed (woff2, woff, ttf, otf)'));
  }
});

module.exports = { upload, fontUpload };
