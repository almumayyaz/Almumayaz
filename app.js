try { require('dotenv').config(); } catch (e) {}

require('express-async-errors');

const express = require('express');
const session = require('cookie-session');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { readData, writeData, readUserById, fbAuth, sendFCM, sendFCMToRole, admin, fbDb, updateData, cacheInvalidate, fsCore, FIRESTORE_COLLECTIONS } = require('./prisma-bridge');
const emailService = require('./email-service');
const localStore = require('./data-store');
const fcmLog = require('./fcm-log');
const supabaseStorage = require('./supabase-storage');
const storageConfig = require('./src/config/storage');
const { getStorageService, validateUpload } = require('./src/infrastructure/storage');
const crypto = require('crypto');
const zlib = require('zlib');
const https = require('https');
const zoom = require('./zoom-oauth');
const analytics = require('./analytics-engine');
const settingService = require('./src/services/setting.service');

const { getPrisma } = require('./src/database');
const { getFirebaseErrorMessage } = require('./src/utils/firebaseErrorMessages');
const perf = require('./perf');
const usageTracker = require('./usage-tracker');

const app = express();

// Load Zoom app credentials from Firebase (overrides env vars at startup)
(async function initZoomCreds() { try { await zoom.loadCredentialsIntoEnv(); } catch(e) { console.error('initZoomCreds:', e.message); } })();

// ===== Extract YouTube video ID from ANY common format =====
// Handles: watch?v=, youtu.be/, /embed/, /shorts/, youtube-nocookie,
// and full <iframe ... src="..."> HTML pasted by users.
function extractYouTubeId(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  const patterns = [
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/|live\/))([a-zA-Z0-9_-]{11})/i,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/i,
    /[?&]v=([a-zA-Z0-9_-]{11})/i,
    /src=["']https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([a-zA-Z0-9_-]{11})/i
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1]) return m[1];
  }
  const idMatch = s.match(/([a-zA-Z0-9_-]{11})/);
  return idMatch ? idMatch[1] : null;
}
app.locals.ytId = extractYouTubeId;
app.locals.escHtml = escHtml;

// ===== Password hashing (native scrypt, no external deps) =====
const SCRYPT_N = 65536, SCRYPT_r = 8, SCRYPT_p = 1, SCRYPT_KEYLEN = 64, SCRYPT_SALTLEN = 16, SCRYPT_MAXMEM = 1024 * 1024 * 128;
function scryptHash(plain) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SCRYPT_SALTLEN);
    crypto.scrypt(String(plain), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: SCRYPT_MAXMEM }, (err, derived) => {
      if (err) return reject(err);
      resolve('scrypt$' + salt.toString('hex') + '$' + derived.toString('hex'));
    });
  });
}
async function verifyPassword(stored, plain) {
  if (!stored || !plain) return false;
  if (typeof stored === 'string' && stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    // Stage 7: async scrypt (no longer blocks the Node event loop on every login).
    const derived = await new Promise((resolve, reject) => {
      crypto.scrypt(String(plain), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: SCRYPT_MAXMEM }, (err, d) => err ? reject(err) : resolve(d));
    });
    return crypto.timingSafeEqual(derived, expected);
  }
  return false;
}

// ===== Client IP (works behind Vercel proxy) =====
function getClientIp(req) {
  return (req.headers && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) ||
         req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

// ===== Receipt image validation =====
function validateReceiptImage(base64) {
  if (!base64 || typeof base64 !== 'string') return 'صورة الإيصال مطلوبة';
  var maxSize = 3 * 1024 * 1024; // 3MB
  var raw, rawLen;
  try {
    rawLen = base64.length * 3 / 4;
    if (rawLen > maxSize) return 'حجم الصورة يجب أن يكون أقل من 3 ميجابايت';
    raw = Buffer.from(base64.split(',')[1] || base64, 'base64');
  } catch(e) { return 'صورة غير صالحة'; }
  var mime = base64.split(';')[0].split(':')[1];
  if (mime && !['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return 'صيغة الصورة غير مدعومة (JPG, PNG, WebP فقط)';
  // Verify image magic bytes
  if (raw && raw.length > 4) {
    var header = raw.toString('hex', 0, 4);
    var isJpeg = header.indexOf('ffd8') === 0;
    var isPng = header.indexOf('89504e47') === 0;
    var isWebp = raw.length > 12 && raw.toString('ascii', 0, 4) === 'RIFF' && raw.toString('ascii', 8, 12) === 'WEBP';
    if (!isJpeg && !isPng && !isWebp) return 'صيغة الصورة غير مدعومة (JPG, PNG, WebP فقط)';
  }
  return null; // valid
}

// ===== Security headers =====
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=*, microphone=*, display-capture=*');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://www.google.com https://cdnjs.cloudflare.com https://cdn.plyr.io https://www.youtube.com https://www.youtube-nocookie.com https://source.zoom.us https://*.zoom.us https://zoom.us https://*.firebaseio.com https://js.puter.com; " +
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.plyr.io https://fonts.googleapis.com https://source.zoom.us https://*.zoom.us https://zoom.us; " +
    "img-src 'self' data: https: blob:; " +
    "font-src 'self' data: https://cdnjs.cloudflare.com https://fonts.gstatic.com https://source.zoom.us; " +
    "media-src 'self' https: blob:; " +
    "connect-src 'self' https://www.gstatic.com https://*.supabase.co https://*.firebaseio.com https://*.googleapis.com https://*.google.com https://firebasestorage.googleapis.com https://*.firebase.com wss://*.firebaseio.com https://source.zoom.us https://*.zoom.us https://zoom.us wss://*.zoom.us https://*.cloudfront.net https://js.puter.com https://api.puter.com https://noembed.com https://cdn.plyr.io; " +
    "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://www.google.com https://source.zoom.us https://*.zoom.us https://zoom.us; " +
    "worker-src 'self' blob:; child-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
  next();
});

// ===== Stage 8: response compression (built-in zlib, no extra deps) =====
// Compresses text-like responses (HTML, JSON, JS, CSS, SVG) when the client advertises
// support. Binary streams (PDF, images) are passed through untouched.
const COMPRESSIBLE_RE = /text\/|application\/(json|javascript|xml|x-www-form-urlencoded)|\+json|\+xml|image\/svg\+xml/;
function compressionMiddleware(req, res, next) {
  if (req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (res.getHeader('Content-Encoding')) return next();
  const ae = (req.headers['accept-encoding'] || '').toLowerCase();
  let encoding = null;
  if (ae.indexOf('br') !== -1) encoding = 'br';
  else if (ae.indexOf('gzip') !== -1) encoding = 'gzip';
  else if (ae.indexOf('deflate') !== -1) encoding = 'deflate';
  if (!encoding) return next();

  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  const origWriteHead = res.writeHead ? res.writeHead.bind(res) : null;
  let stream = null;
  let replaced = false;

  function ensureStream() {
    if (stream) return;
    const ct = (res.getHeader('Content-Type') || '').toLowerCase();
    if (!COMPRESSIBLE_RE.test(ct)) return; // not worth compressing / binary
    replaced = true;
    res.removeHeader('Content-Length');
    res.setHeader('Content-Encoding', encoding);
    if (encoding === 'gzip') stream = zlib.createGzip();
    else if (encoding === 'deflate') stream = zlib.createDeflate();
    else stream = zlib.createBrotliCompress();
    stream.on('data', c => { origWrite(c); });
    stream.on('end', () => { origEnd(); });
    stream.on('error', () => { /* swallow; response already partial */ });
  }

  res.write = function (chunk, ...args) {
    ensureStream();
    if (stream && replaced) { stream.write(chunk); return true; }
    return origWrite(chunk, ...args);
  };
  res.end = function (chunk, ...args) {
    ensureStream();
    if (stream && replaced) {
      if (chunk) stream.write(chunk);
      stream.end();
      return res;
    }
    return origEnd(chunk, ...args);
  };
  next();
}
app.use(compressionMiddleware);

// ===== CSRF / same-origin check for state-changing requests =====
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const host = req.get('host');
  const origin = req.get('origin');
  const referer = req.get('referer');
  var appUrl = process.env.APP_URL || '';
  var allowedHosts = [host, 'almumayaz.vercel.app', 'www.almumayaz.online', 'almumayaz.online'];
  // Also parse APP_URL for additional hosts
  try { if (appUrl) allowedHosts.push(new URL(appUrl).host); } catch(e) {}
  var ok = false;
  try { if (origin && allowedHosts.indexOf(new URL(origin).host) !== -1) ok = true; } catch (e) {}
  try { if (!ok && referer && allowedHosts.indexOf(new URL(referer).host) !== -1) ok = true; } catch (e) {}
  if (!ok) return res.status(403).json({ error: 'طلب غير مسموح' });
  next();
});

const _rateBuckets = {};
const _rateLimiterMem = {}; // fallback in-memory when FB unavailable
// Rate limiter — uses RTDB transaction for cross-instance atomicity on Vercel
const RATE_LIMITS = {
  'AUTH_LIMIT': { window: 15 * 60 * 1000, max: 30 },
  'ANALYTICS_LIMIT': { window: 15 * 60 * 1000, max: 400 },
  'CONTACT_LIMIT': { window: 60 * 60 * 1000, max: 5 }
};
function getRateLimitKey(limitName, suffix) {
  return limitName + ':' + suffix;
}
const _rateLimiterFbReady = (function() {
  try { return require('./prisma-bridge').transactionData ? true : false; } catch(e) { return false; }
})();
app.use(async function(req, res, next) {
  var path = req.path;
  var limitName = null;
  if (path.indexOf('/api/auth/') === 0 || path === '/login' || path === '/register' || path === '/forgot-password' || path === '/demo' || path.indexOf('/api/parent/') === 0 || path.indexOf('/api/student/redeem-code') === 0 || path.indexOf('/api/student/apply-referral') === 0) limitName = 'AUTH_LIMIT';
  else if (path.indexOf('/api/analytics/') === 0) limitName = 'ANALYTICS_LIMIT';
  else if (path === '/api/contact') limitName = 'CONTACT_LIMIT';
  if (!limitName) return next();
  var cfg = RATE_LIMITS[limitName];
  var ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || 'unknown';
  var key = getRateLimitKey(limitName, ip + ':' + path);
  var now = Date.now();

  if (_rateLimiterFbReady) {
    try {
      const { transactionData } = require('./prisma-bridge');
      var allowed = false;
      await transactionData('rateLimits/' + key, function(current) {
        if (!current || now - (current.start || 0) > cfg.window) {
          allowed = true;
          return { start: now, count: 1 };
        }
        current.count = (current.count || 0) + 1;
        if (current.count > cfg.max) { allowed = false; return current; }
        allowed = true;
        return current;
      });
      if (!allowed) { usageTracker.trackRateLimit(limitName); return res.status(429).json({ error: 'طلبات كثيرة جداً، يرجى الانتظار' }); }
      return next();
    } catch (e) {
      // fall through to in-memory fallback
    }
  }

  // In-memory fallback (single-instance or dev)
  var bucket = _rateBuckets[key];
  if (!bucket || now - bucket.start > cfg.window) {
    _rateBuckets[key] = { start: now, count: 1 };
    return next();
  }
  bucket.count++;
  if (bucket.count > cfg.max) { usageTracker.trackRateLimit(limitName); return res.status(429).json({ error: 'طلبات كثيرة جداً، يرجى الانتظار' }); }
  next();
});

// Stage 15: attach per-request performance context (reads/writes/cache hit-miss/timing).
app.use(perf.middleware);

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(bodyParser.json({ limit: '50mb' }));
// In production the session cookie must be sameSite:'none' + secure so the browser
// sends it on the cross-site top-level redirect from zoom.us back to /auth/zoom/callback
// (otherwise the Zoom OAuth state/CSRF check fails with "طلب غير مصرح به").
// In local dev (http) we keep sameSite:'lax' so the cookie is usable on localhost.
var isProd = process.env.NODE_ENV === 'production';

app.use(session({
  name: 'lughati_session',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  maxAge: 30 * 24 * 60 * 60 * 1000,
  sameSite: isProd ? 'none' : 'lax',
  httpOnly: true,
  secure: isProd
}));

app.use(cookieParser());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Patch EJS to enable async mode (fixes catch keyword in templates)
const ejs = require('ejs');
const origRenderFile = ejs.renderFile;
ejs.renderFile = function(filePath, options, cb) {
  if (typeof cb === 'function') {
    return origRenderFile(filePath, options, { async: true }, cb);
  }
  return origRenderFile(filePath, options, { async: true });
};

const multer = require('multer');
const mammoth = require('mammoth');
var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    var allowedMimes = ['image/jpeg','image/png','image/webp','image/gif','application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','text/plain','application/zip'];
    if (allowedMimes.indexOf(file.mimetype) !== -1) return cb(null, true);
    cb(null, false);
  }
});

var uploadWord = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    var allowedMimes = ['application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/octet-stream','application/zip'];
    var ext = path.extname(file.originalname || '').toLowerCase();
    if (allowedMimes.indexOf(file.mimetype) !== -1 || ext === '.doc' || ext === '.docx') return cb(null, true);
    cb(null, false);
  }
});

function stripBOM(s) {
  if (!s || typeof s !== 'string') return s;
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

// Keep only lightweight fields in the session COOKIE (cookie-session has a ~4KB limit;
// a Base64 avatar or large progress object would overflow it and drop the Set-Cookie,
// bouncing students back to /login). Heavy fields are re-attached from the DB for views.

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function sessionUser(u) {
  if (!u || typeof u !== 'object') return u;
  const c = {};
  ['id','uid','name','email','role','stage','grade','governorate','phone','parentPhone','parentId','parentName','parentEmail','subscribedStage','planName','planPeriod','subscriptionStatus','subscriptionStart','subscriptionEnd','referralCode','referralDiscount','referralUsedAt','emailVerified','isStudent'].forEach(function(k){
    if (k in u) c[k] = u[k];
  });
  return c;
}

// ===== Email (Brevo Transactional API) =====
function genEmailCode() { return String(crypto.randomInt(100000, 1000000)); }
const EMAIL_CODE_TTL = 30 * 60 * 1000;

// Safe error helper — logs actual error, returns generic message to client
function safeErr(e, fallback) {
  console.error('[safeErr]', e && (e.stack || e.message || e));
  return fallback || 'تعذر إتمام العملية، حاول مرة أخرى.';
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  // Re-verify role from DB to guard against stale session after role downgrade
  getPrisma().user.findUnique({ where: { id: req.session.user.id }, select: { role: true } }).then(function(u) {
    if (!u || u.role !== 'admin') return res.redirect('/login');
    req.session.user.role = u.role;
    next();
  }).catch(function() {
    next();
  });
}

function requireDevAccess(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') return next();
  if (req.session.devPanelAccess) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/dev');
}

// V2 API (Phase 7) — Service layer routes
const v2Api = require('./src/api/v2');
app.use('/api/v2', v2Api);

// V3 API — Prisma + Neon with Clean Architecture
const v3Routes = require('./src/routes');
app.use('/api/v3', v3Routes);

function checkSubscription(req, res, next) {
  const user = req.session.user;
  if (!user || user.role === 'admin') return next();
  if (user.subscriptionStatus === 'active' && user.subscriptionEnd) {
    const end = new Date(user.subscriptionEnd);
    if (end < new Date()) {
      user.subscriptionStatus = 'expired';
      (async () => {
        try {
          const prisma = getPrisma();
          await prisma.user.update({ where: { id: user.id }, data: { subscriptionStatus: 'expired' } });
          await prisma.userSubscription.updateMany({
            where: { userId: user.id, status: 'active', deletedAt: null },
            data: { status: 'expired', endDate: new Date() }
          });
        } catch (_) {}
        sendFCM(user.id, 'انتهى اشتراكك في المُميز', 'لقد انتهت صلاحية اشتراكك. قم بتجديد الاشتراك للاستمرار في مشاهدة المحاضرات.', '/student/subscription');
      })();
    }
  }
  next();
}

// Refresh student session data from DB on every request (throttled to 30s)
async function refreshSession(req, res, next) {
  const user = req.session.user;
  if (!user || user.role === 'admin') return next();
  const now = Date.now();
  if (user._lastSync && (now - user._lastSync) < 30000) return next();
  try {
    const fresh = await readUserById(user.id);
    if (fresh) {
      ['subscriptionStatus','subscriptionEnd','subscriptionStart','name','phone','parentPhone','stage','grade','governorate','referralCode','referralDiscount'].forEach(k => {
        req.session.user[k] = fresh[k];
      });
      req.session.user._lastSync = now;
    }
  } catch(e) {}
  next();
}

app.use(async (req, res, next) => {
  res.locals.user = req.session.user ? Object.assign({}, req.session.user) : null;
  // Re-attach heavy fields (avatar/progress) from the DB for views.
  // These are NOT stored in the session cookie (would overflow the ~4KB limit).
  if (res.locals.user && res.locals.user.uid) {
    // Stage 1: if these view fields are already present in the (cookie) session,
    // there is no need to touch the database at all. The session is refreshed by
    // refreshSession()/login, so these stay current without a per-request read.
    const haveSessionFields = res.locals.user.avatar !== undefined &&
      res.locals.user.progress !== undefined && res.locals.user.referrals !== undefined;
    if (!haveSessionFields) {
      try {
        const _full = res.locals.user.id ? await readUserById(res.locals.user.id) : null;
        if (_full) {
          res.locals.user.avatar = _full.avatar || '';
          if (res.locals.user.avatar && !res.locals.user.avatar.startsWith('data:') && storageConfig.isR2Enabled()) {
            try { res.locals.user.avatar = await getStorageService().createPublicUrl(res.locals.user.avatar); } catch (_) {}
          }
          res.locals.user.progress = _full.progress || {};
          res.locals.user.referrals = _full.referrals || [];
        }
      } catch (e) {}
    } else {
      // Normalise in case a stale cookie is missing a field.
      if (res.locals.user.avatar === undefined) res.locals.user.avatar = '';
      if (res.locals.user.progress === undefined) res.locals.user.progress = {};
      if (res.locals.user.referrals === undefined) res.locals.user.referrals = [];
    }
  }
  res.locals.currentPath = req.path;
  res.locals.darkMode = req.session.darkMode || false;
  res.locals.isGuest = !!req.session.demoMode;
  // Unread notification count for the badge (only for logged-in student/admin)
  try {
    const _u = req.session.user;
    if (_u && (_u.role === 'student' || _u.role === 'admin')) {
      const _all = await readData('notifications') || [];
      const _dismissed = await readData('dismissed/' + _u.id) || {};
      const _unread = _all.filter(function(n) {
        if (n.target === 'all') return !_dismissed[n.id];
        if (_u.role === 'admin') return (n.target === 'admin' || n.source === 'chat') && !_dismissed[n.id];
        if (n.target === 'student' && n.targetValue === _u.id) return !_dismissed[n.id];
        if (n.target === 'grade' && n.targetValue === _u.grade) return !_dismissed[n.id];
        if (n.target === 'stage' && n.targetValue === _u.stage) return !_dismissed[n.id];
        return false;
      }).length;
      res.locals.unreadCount = _unread;
    } else {
      res.locals.unreadCount = 0;
    }
  } catch (e) { res.locals.unreadCount = 0; }
  next();
});
// Maintenance mode: block normal browsing for non-admins when enabled
app.use(async (req, res, next) => {
  const p = req.path;
  // Bypass: admin panel, auth/login flows, APIs, and static assets
  if (p.startsWith('/admin') || p.startsWith('/auth') || p.startsWith('/login') || p.startsWith('/logout') ||
      p.startsWith('/api') || p.startsWith('/css') || p.startsWith('/js') || p.startsWith('/img') ||
      p.startsWith('/icon') || p === '/manifest.json' || p === '/sw.js' || p.startsWith('/uploads')) {
    return next();
  }
  try {
    var _siteSettings = {};
    try { _siteSettings = await readData('settings') || {}; } catch(e) {}
    var _waNum = _siteSettings.contactWhatsapp || '01069107805';
    var _waClean = _waNum.replace(/\D/g,'').replace(/^0/,'');
    const mm = await readData('maintenanceMode');
        if (mm && mm.enabled) {
      const u = res.locals.user;
      if (!u || u.role !== 'admin') {
        const msg = mm.message || 'نعتذر، المنصة قيد الصيانة حالياً. يرجى المحاولة لاحقاً.';
        return res.status(503).send(
          '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>المنصة قيد الصيانة</title>' +
          '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">' +
          '<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&display=swap" rel="stylesheet">' +
          '<style>*{box-sizing:border-box;margin:0;padding:0;scrollbar-width:none;-ms-overflow-style:none}*::-webkit-scrollbar{display:none}' +
          'body{font-family:Cairo,Tahoma,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
          'background:#0f172a;color:#e2e8f0;padding:20px;overflow:hidden;position:relative;}' +
          /* animated bg grid */
          'body::before{content:"";position:fixed;inset:0;' +
          'background-image:linear-gradient(rgba(245,158,11,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(245,158,11,.03) 1px,transparent 1px);' +
          'background-size:60px 60px;pointer-events:none;}' +
          /* radial glow */
          'body::after{content:"";position:fixed;top:-40%;left:-20%;width:80%;height:80%;border-radius:50%;' +
          'background:radial-gradient(circle,rgba(245,158,11,.08) 0%,transparent 70%);pointer-events:none;}' +
          '.wrap{text-align:center;max-width:480px;animation:rise .7s cubic-bezier(.22,1,.36,1) both;position:relative;z-index:1;}' +
          '@keyframes rise{from{opacity:0;transform:translateY(24px);}to{opacity:1;transform:translateY(0);}}' +
          /* logo ring */
          '.ring{width:100px;height:100px;margin:0 auto 24px;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
          'background:linear-gradient(135deg,#F59E0B,#D97706,#B45309);box-shadow:0 0 0 4px rgba(245,158,11,.15),0 20px 50px rgba(245,158,11,.25);' +
          'position:relative;}' +
          '.ring i{font-size:40px;color:#fff;animation:spin 4s linear infinite;}' +
          '@keyframes spin{to{transform:rotate(360deg);}}' +
          '.ring::before{content:"";position:absolute;inset:-6px;border-radius:50%;border:2px solid rgba(245,158,11,.2);' +
          'animation:pulse 2.5s ease-out infinite;}' +
          '.ring::after{content:"";position:absolute;inset:-14px;border-radius:50%;border:1px solid rgba(245,158,11,.1);' +
          'animation:pulse 2.5s ease-out .8s infinite;}' +
          '@keyframes pulse{0%{transform:scale(1);opacity:.6;}100%{transform:scale(1.2);opacity:0;}}' +
          /* floating dots */
          '.dot{position:fixed;border-radius:50%;background:rgba(245,158,11,.12);pointer-events:none;animation:float 6s ease-in-out infinite;}' +
          '.dot:nth-child(1){width:6px;height:6px;top:15%;left:12%;animation-delay:0s;}' +
          '.dot:nth-child(2){width:10px;height:10px;top:65%;left:85%;animation-delay:1.2s;}' +
          '.dot:nth-child(3){width:8px;height:8px;top:80%;left:20%;animation-delay:2.4s;}' +
          '.dot:nth-child(4){width:12px;height:12px;top:25%;left:78%;animation-delay:3.6s;}' +
          '.dot:nth-child(5){width:5px;height:5px;top:55%;left:8%;animation-delay:4.8s;}' +
          '@keyframes float{0%,100%{transform:translateY(0) scale(1);opacity:.5;}50%{transform:translateY(-20px) scale(1.3);opacity:1;}}' +
          '.brand{font-size:14px;letter-spacing:2px;color:#F59E0B;margin-bottom:4px;font-weight:900;text-transform:uppercase;}' +
          'h1{font-size:28px;margin-bottom:8px;color:#f8fafc;font-weight:900;}' +
          'h1 span{color:#F59E0B;}' +
          '.sub{font-size:14px;color:#64748b;margin-bottom:22px;line-height:1.7;}' +
          '.msg-box{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:16px;' +
          'padding:18px 22px;margin-bottom:22px;text-align:center;}' +
          '.msg-box i{color:#F59E0B;font-size:18px;display:block;margin-bottom:8px;}' +
          '.msg-box .msg-text{font-size:15px;line-height:1.8;color:#cbd5e1;}' +
          /* contact buttons */
          '.actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:18px;}' +
          '.actions a{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;border-radius:12px;text-decoration:none;' +
          'font-size:13px;font-weight:600;transition:all .25s;}' +
          '.actions .whatsapp{background:rgba(34,197,94,.12);color:#22c55e;border:1px solid rgba(34,197,94,.2);}' +
          '.actions .whatsapp:hover{background:rgba(34,197,94,.2);transform:translateY(-2px);}' +
          '.actions .email{background:rgba(245,158,11,.12);color:#F59E0B;border:1px solid rgba(245,158,11,.2);}' +
          '.actions .email:hover{background:rgba(245,158,11,.2);transform:translateY(-2px);}' +
          '.note{font-size:12.5px;color:#475569;line-height:1.7;}' +
          '.note i{color:#F59E0B;}' +
          '@media(max-width:480px){h1{font-size:22px;}.ring{width:80px;height:80px;}.ring i{font-size:32px;}}' +
          '</style></head><body>' +
          '<span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="dot"></span>' +
          '<div class="wrap">' +
          '<div class="ring"><i class="fas fa-gear"></i></div>' +
          '<div class="brand">✦ المُميز ✦</div>' +
          '<h1>نحن <span>نتطور</span> من أجلك</h1>' +
          '<p class="sub">نعمل حالياً على تحسينات جديدة لنقدم لك تجربة أفضل</p>' +
          '<div class="msg-box"><i class="fas fa-quote-right"></i><div class="msg-text">' + String(msg).replace(/</g,'&lt;') + '</div></div>' +
          '<div class="actions">' +
          '<a href="https://wa.me/20' + _waClean + '" target="_blank" class="whatsapp"><i class="fab fa-whatsapp"></i> واتساب</a>' +
          '<a href="mailto:almumayyaz.info@gmail.com" class="email"><i class="fas fa-envelope"></i> بريد</a>' +
          '</div>' +
          '<p class="note"><i class="fas fa-heart" style="color:#ef4444;"></i> شكراً لصبرك، سنعود قريباً جداً</p>' +
          '</div></body></html>'
        );
      }
    }
  } catch (e) { /* ignore maintenance read errors, allow request */ }
  next();
});
// Platform theme: inject custom colors + button shape + font (cached, applies to all pages)
app.use(async (req, res, next) => {
  try {
    res.locals.themeStyle = await getThemeCss();
    const t = await readData('themeConfig');
    res.locals.themeAccent = t && t.accent ? t.accent : '#F59E0B';
    res.locals.themeFont = t && t.fontName ? t.fontName : '';
    res.locals.themeFontEncoded = res.locals.themeFont ? res.locals.themeFont.replace(/\s+/g, '+') : '';
  } catch (e) { res.locals.themeStyle = ''; res.locals.themeAccent = '#F59E0B'; res.locals.themeFont = ''; res.locals.themeFontEncoded = ''; }
  next();
});
// Dynamic manifest.json — reads theme accent from admin settings
app.get('/manifest.json', async (req, res) => {
  try {
    const t = await readData('themeConfig');
    const accent = t && t.accent ? t.accent : '#F59E0B';
    res.json({
      name: 'منصة المُميز التعليمية',
      short_name: 'المُميز',
      description: 'منصة المُميز التعليمية - اللغة العربية مع الأستاذ محمد عفيفي',
      start_url: '/',
      display: 'standalone',
      background_color: accent,
      theme_color: accent,
      orientation: 'any',
      dir: 'rtl',
      lang: 'ar',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
      ]
    });
  } catch (_) {
    res.json({
      name: 'منصة المُميز التعليمية',
      short_name: 'المُميز',
      description: 'منصة المُميز التعليمية - اللغة العربية مع الأستاذ محمد عفيفي',
      start_url: '/',
      display: 'standalone',
      background_color: '#F59E0B',
      theme_color: '#F59E0B',
      orientation: 'any',
      dir: 'rtl',
      lang: 'ar',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
      ]
    });
  }
});
// API endpoint for live unread count (polled by the bell icon)
app.get('/api/unread-count', async (req, res) => {
  try {
    const u = req.session.user;
    if (!u || (u.role !== 'student' && u.role !== 'admin')) return res.json({ count: 0 });
    const all = await readData('notifications') || [];
    const dismissed = await readData('dismissed/' + u.id) || {};
    const count = all.filter(function(n) {
      if (n.target === 'all') return !dismissed[n.id];
      if (u.role === 'admin') return (n.target === 'admin' || n.source === 'chat') && !dismissed[n.id];
      if (n.target === 'student' && n.targetValue === u.id) return !dismissed[n.id];
      if (n.target === 'grade' && n.targetValue === u.grade) return !dismissed[n.id];
      if (n.target === 'stage' && n.targetValue === u.stage) return !dismissed[n.id];
      return false;
    }).length;
    res.json({ count: count });
  } catch (e) { res.json({ count: 0 }); }
});
// End API unread-count

// Splash page HTML — function so / can inject the correct redirect
function splashHTML(redirectUrl) {
  redirectUrl = redirectUrl || '/login';
  return '' +
    '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
    '<title>المُميز — منصة تعليم اللغة العربية</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&family=Aref+Ruqaa:wght@400;700&display=swap" rel="stylesheet">' +
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">' +
    '<style>' +
    '*{box-sizing:border-box;margin:0;padding:0;scrollbar-width:none;-ms-overflow-style:none}*::-webkit-scrollbar{display:none}' +
    'body{' +
    'font-family:Cairo,Tahoma,sans-serif;' +
    'min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#0f172a;color:#e2e8f0;padding:20px;overflow:hidden;' +
    'position:relative;' +
    '}' +
    'body::before{content:"";position:fixed;inset:0;' +
    'background:radial-gradient(ellipse at 50% 30%,rgba(245,158,11,.06) 0%,transparent 60%),' +
    'radial-gradient(ellipse at 80% 80%,rgba(59,130,246,.03) 0%,transparent 50%);' +
    'animation:bgShift 8s ease-in-out infinite alternate;' +
    'pointer-events:none;}' +
    '@keyframes bgShift{0%{opacity:.6;transform:scale(1);}100%{opacity:1;transform:scale(1.03);}}' +
    '.wrap{text-align:center;position:relative;z-index:1;animation:rise .9s cubic-bezier(.22,1,.36,1) both;}' +
    '@keyframes rise{from{opacity:0;transform:translateY(40px) scale(.92);}to{opacity:1;transform:translateY(0) scale(1);}}' +
    /* main title — المُميز */
    '.main-title{' +
    'font-family:\'Aref Ruqaa\',serif;' +
    'font-size:clamp(100px,26vw,220px);font-weight:700;line-height:1.1;' +
    'background:linear-gradient(135deg,#FBBF24 0%,#F59E0B 30%,#D97706 60%,#FCD34D 100%);' +
    'background-size:200% auto;' +
    '-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;' +
    'filter:drop-shadow(0 0 40px rgba(245,158,11,.3)) drop-shadow(0 8px 40px rgba(0,0,0,.2));' +
    'animation:titleGlow 3s ease-in-out infinite, titleShimmer 4s linear infinite, titleFloat 5s ease-in-out infinite;' +
    'margin-bottom:10px;' +
    '}' +
    '@keyframes titleGlow{0%,100%{filter:drop-shadow(0 0 40px rgba(245,158,11,.3)) drop-shadow(0 8px 40px rgba(0,0,0,.2));}' +
    '50%{filter:drop-shadow(0 0 70px rgba(245,158,11,.5)) drop-shadow(0 8px 60px rgba(0,0,0,.3));}}' +
    '@keyframes titleShimmer{0%{background-position:0% center;}100%{background-position:200% center;}}' +
    '@keyframes titleFloat{0%,100%{transform:translateY(0);}50%{transform:translateY(-10px);}}' +
    '.main-title .m{background:linear-gradient(135deg,#FCD34D,#F59E0B,#D97706);background-size:200% auto;-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;animation:titleShimmer 4s linear infinite;}' +
    /* subtitle */
    '.sub{' +
    'font-family:Cairo,Tahoma,sans-serif;' +
    'font-size:clamp(20px,5vw,36px);font-weight:700;' +
    'color:rgba(255,255,255,.6);' +
    'letter-spacing:2px;margin-bottom:36px;' +
    'animation:subFade 1.5s .3s both;' +
    '}' +
    '@keyframes subFade{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);}}' +
    /* decorative rings behind title */
    '.bg-ring{position:absolute;top:50%;left:50%;border-radius:50%;border:2px solid;transform:translate(-50%,-50%);pointer-events:none;}' +
    '.bg-ring:nth-child(1){width:clamp(340px,65vw,700px);height:clamp(340px,65vw,700px);border-color:rgba(245,158,11,.1);animation:bgRingSpin 20s linear infinite;}' +
    '.bg-ring:nth-child(2){width:clamp(420px,78vw,850px);height:clamp(420px,78vw,850px);border-color:rgba(245,158,11,.05);border-width:1px;animation:bgRingSpin 30s linear infinite reverse;}' +
    '.bg-ring:nth-child(3){width:clamp(260px,50vw,550px);height:clamp(260px,50vw,550px);border-color:rgba(59,130,246,.06);border-width:1px;border-style:dashed;animation:bgRingSpin 15s linear infinite;}' +
    '@keyframes bgRingSpin{0%{transform:translate(-50%,-50%) rotate(0deg);}100%{transform:translate(-50%,-50%) rotate(360deg);}}' +
    /* verse */
    '.verse{' +
    'font-family:\'Aref Ruqaa\',serif;' +
    'font-size:clamp(28px,6vw,48px);color:#94a3b8;line-height:2;' +
    'margin-bottom:0;animation:verseIn 1.5s .6s both;' +
    '}' +
    '@keyframes verseIn{from{opacity:0;transform:translateY(15px);}to{opacity:1;transform:translateY(0);}}' +
    '.verse .ref{display:block;font-family:Cairo,Tahoma,sans-serif;font-size:clamp(12px,2vw,16px);color:#475569;margin-top:6px;}' +
    /* background particles */
    '.p{position:fixed;border-radius:50%;pointer-events:none;animation:float 10s ease-in-out infinite;}' +
    '.p:nth-child(1){width:6px;height:6px;background:rgba(245,158,11,.08);top:15%;left:10%;}' +
    '.p:nth-child(2){width:4px;height:4px;background:rgba(59,130,246,.08);top:75%;left:88%;animation-delay:2s;}' +
    '.p:nth-child(3){width:8px;height:8px;background:rgba(245,158,11,.06);top:82%;left:20%;animation-delay:4s;}' +
    '.p:nth-child(4){width:5px;height:5px;background:rgba(139,92,246,.08);top:25%;left:78%;animation-delay:6s;}' +
    '.p:nth-child(5){width:6px;height:6px;background:rgba(245,158,11,.06);top:50%;left:6%;animation-delay:3s;}' +
    '.p:nth-child(6){width:3px;height:3px;background:#F59E0B;top:40%;left:72%;animation-delay:7s;}' +
    '@keyframes float{0%,100%{transform:translateY(0) scale(1);opacity:.3;}50%{transform:translateY(-40px) scale(1.8);opacity:.6;}}' +
    '@media(max-width:480px){.main-title{font-size:clamp(64px,22vw,100px)!important;}.verse{font-size:clamp(20px,6vw,28px)!important;}.sub{font-size:clamp(16px,5vw,20px)!important;}}' +
    '</style></head><body>' +
    '<span class="p"></span><span class="p"></span><span class="p"></span>' +
    '<span class="p"></span><span class="p"></span><span class="p"></span>' +
    '<div class="wrap">' +
    '<span class="bg-ring"></span><span class="bg-ring"></span><span class="bg-ring"></span>' +
    '<div class="main-title">الم<span class="m">م</span>يز</div>' +
    '<div class="sub">مِنَصَّةُ اللُّغَةِ العَرَبِيَّةِ</div>' +
    '<div class="verse">' +
    'إِنَّا أَنزَلْنَاهُ قُرْآنًا عَرَبِيًّا لَّعَلَّكُمْ تَعْقِلُونَ' +
    '<span class="ref">يوسف — ٢</span>' +
    '</div>' +
    '</div>' +
    '<script>setTimeout(function(){window.location.replace("' + redirectUrl + '");},2000)</script>' +
    '</body></html>';
}

// GET /lo — Splash page (standalone)
app.get('/lo', function(req, res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.send(splashHTML('/login'));
});

app.use(async (req, res, next) => {
res.locals.firebaseConfig = {
    apiKey: stripBOM(process.env.FIREBASE_API_KEY || ''),
    authDomain: stripBOM(process.env.FIREBASE_AUTH_DOMAIN || ''),
    projectId: stripBOM(process.env.FIREBASE_PROJECT_ID || ''),
    storageBucket: stripBOM(process.env.FIREBASE_STORAGE_BUCKET || ''),
    messagingSenderId: stripBOM(process.env.FIREBASE_MESSAGING_SENDER_ID || ''),
    appId: stripBOM(process.env.FIREBASE_APP_ID || '')
  };
  res.locals.vapidKey = stripBOM(process.env.FIREBASE_VAPID_KEY || '');
  try {
    // Dual-read: V2 Firestore first, legacy RTDB fallback (Phase 2)
    var appSettings = await settingService.getSettings();
    if (appSettings && typeof appSettings === 'object' && !Array.isArray(appSettings)) {
      res.locals.vodafoneCash = appSettings.vodafoneCash || stripBOM(process.env.VODAFONE_CASH || '01000000000');
      res.locals.instaPay = appSettings.instaPay || stripBOM(process.env.INSTAPAY || 'example@instapay.com');
      res.locals.currentSemester = appSettings.currentSemester || 'all';
      res.locals.siteSettings = appSettings || {};
    } else {
      res.locals.vodafoneCash = stripBOM(process.env.VODAFONE_CASH || '01000000000');
      res.locals.instaPay = stripBOM(process.env.INSTAPAY || 'example@instapay.com');
      res.locals.currentSemester = 'all';
      res.locals.siteSettings = {};
    }
  } catch (e) {
    res.locals.vodafoneCash = stripBOM(process.env.VODAFONE_CASH || '01000000000');
    res.locals.instaPay = stripBOM(process.env.INSTAPAY || 'example@instapay.com');
    res.locals.currentSemester = 'all';
    res.locals.siteSettings = {};
  }
  next();
});

app.use(refreshSession);

/* ===================== AUTO-MIGRATION ===================== */
(async function autoMigrate() {
  try {
    // Migrate courses: videoUrl → videos[], pdfUrl → pdfFiles[]
    var courses = (await readData('courses')) || [];
    var coursesChanged = false;
    courses.forEach(function(c) {
      if (c.quiz && !Array.isArray(c.quiz.questions)) { c.quiz.questions = []; coursesChanged = true; }
      (c.lessons || []).forEach(function(l) {
        if (l.videoUrl && (!l.videos || l.videos.length === 0)) {
          l.videos = [{ title: 'فيديو', url: l.videoUrl }];
          delete l.videoUrl;
          coursesChanged = true;
        }
        if (l.pdfUrl && (!l.pdfFiles || l.pdfFiles.length === 0)) {
          l.pdfFiles = [{ title: 'ملف', url: l.pdfUrl }];
          delete l.pdfUrl;
          coursesChanged = true;
        }
      });
    });
    if (coursesChanged) await writeData('courses', courses);
    // Migrate reviews: videoUrl → videos[], pdfUrl → pdfFiles[], add courseId from course name
    var reviews = (await readData('reviews')) || [];
    var reviewsChanged = false;
    reviews.forEach(function(r) {
      if (r.quiz && !Array.isArray(r.quiz.questions)) { r.quiz.questions = []; reviewsChanged = true; }
      if (r.videoUrl && (!r.videos || r.videos.length === 0)) {
        r.videos = [{ title: 'فيديو', url: r.videoUrl }];
        delete r.videoUrl;
        reviewsChanged = true;
      }
      if (r.pdfUrl && (!r.pdfFiles || r.pdfFiles.length === 0)) {
        r.pdfFiles = [{ title: 'ملف', url: r.pdfUrl }];
        delete r.pdfUrl;
        reviewsChanged = true;
      }
      if (!r.courseId && r.course) {
        var match = courses.find(function(c) { return c.title === r.course; });
        if (match) r.courseId = match.id;
        reviewsChanged = true;
      }
      if (r.order === undefined) { r.order = 0; reviewsChanged = true; }
      if (r.isFree === undefined) { r.isFree = false; reviewsChanged = true; }
    });
    if (reviewsChanged) await writeData('reviews', reviews);
    // Migrate users: add referralDiscount — deferred to Prisma schema defaults
    // Delete lughati-chat if it exists
    try {
const { fbRemove } = require('./prisma-bridge');
      await fbRemove('chats/student-lughati-chat');
    } catch(e) {}
    // Fix settings if stored as array (from migration bug)
    try {
      var s = await readData('settings');
      if (Array.isArray(s)) {
        var fixed = { currentSemester: 'all', vodafoneCash: process.env.VODAFONE_CASH || '01000000000', instaPay: process.env.INSTAPAY || 'example@instapay.com' };
        await writeData('settings', fixed);
        console.log('Fixed corrupted settings (array → object)');
      }
    } catch(e) {}
    console.log('Auto-migration complete');
  } catch(e) {
    console.log('Auto-migration note:', e.message);
  }
})();

/* ===================== AUTH ===================== */

app.post('/api/auth/firebase-login', async (req, res) => {
  try {
    const { idToken } = req.body;
    let decoded;
    if (fbAuth) {
      decoded = await fbAuth.verifyIdToken(idToken);
    } else {
      // Fallback: verify idToken via Firebase REST API when Admin SDK not available
      const apiKey = process.env.FIREBASE_API_KEY;
      if (!apiKey) return res.status(503).json({ error: 'خدمة المصادقة غير متاحة حالياً' });
      const verifyResp = await fetch('https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=' + apiKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      });
      const verifyData = await verifyResp.json();
      if (verifyData.error) return res.status(503).json({ error: 'خدمة المصادقة غير متاحة حالياً' });
      const account = verifyData.users && verifyData.users[0];
      if (!account) return res.status(503).json({ error: 'خدمة المصادقة غير متاحة حالياً' });
      decoded = { uid: account.localId, email: account.email, displayName: account.displayName };
    }
    const uid = decoded.uid;
    const prisma = getPrisma();
    let user = await prisma.user.findFirst({
      where: { OR: [{ id: uid }, { uid }], deletedAt: null }
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          id: uid,
          uid,
          name: decoded.displayName || 'طالب',
          email: decoded.email || '',
          phone: '',
          parentPhone: '',
          grade: '',
          stage: '',
          governorate: '',
          role: 'student',
          subscriptionStatus: 'inactive',
          referralCode: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
          referralDiscount: 0,
          createdAt: new Date(),
          lastLogin: new Date(),
        }
      });
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: new Date() }
      });
    }

    // Block login if email verification was sent but not completed
    if (user.emailVerified === false) {
      return res.json({ error: 'email_not_verified', email: user.email });
    }

    req.session = { user: sessionUser(user), darkMode: req.session.darkMode || false };
    if (user.role === 'student') {
    analytics.trackLogin(user.uid, { device: req.headers['user-agent'] || '', browser: req.headers['user-agent'] || '', ip: req.ip || req.connection.remoteAddress || '' }).catch(function(){});
  }
    res.json({ success: true, redirect: user.role === 'admin' ? '/admin' : '/student' }); } catch (e) {
      console.error('[Firebase Login Error]', e.message || e);
      res.status(401).json({ error: getFirebaseErrorMessage(e) });
    }
  });

app.post('/api/auth/firebase-register', async (req, res) => {
  try {
    if (!fbAuth) return res.status(503).json({ error: 'خدمة المصادقة غير متاحة حالياً' });
    const { idToken, name, email, phone, parentPhone, grade, stage, governorate, phoneVerified } = req.body;
    const decoded = await fbAuth.verifyIdToken(idToken);
    const uid = decoded.uid;

    const prisma = getPrisma();
    const existing = await prisma.user.findFirst({ where: { email, deletedAt: null } });
    if (existing) {
      return res.status(409).json({ error: 'حدث خطأ في التسجيل، يرجى المحاولة مرة أخرى' });
    }

    const newUser = {
      id: uid,
      uid,
      name,
      email,
      phone: phone || '',
      parentPhone: parentPhone || '',
      grade: grade || '',
      stage: stage || '',
      governorate: governorate || '',
      role: 'student',
      subscriptionStatus: 'inactive',
      referralCode: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
      createdAt: new Date(),
      lastLogin: new Date(),
      emailVerified: false,
      emailCode: genEmailCode(),
      emailCodeExpiry: new Date(Date.now() + EMAIL_CODE_TTL),
      phoneVerified: !!phoneVerified,
      phoneVerifiedAt: phoneVerified ? new Date() : null
    };

    await prisma.user.create({ data: newUser });

    const sent = await emailService.sendVerificationEmail(email, name, newUser.emailCode);
    res.json({ success: true, emailSent: sent, email });
  } catch (e) {
    console.error('[Firebase Register Error]', e);
    res.status(401).json({ error: getFirebaseErrorMessage(e) });
  }
});

async function loadUsers() {
  const prisma = getPrisma();
  return prisma.user.findMany({ where: { deletedAt: null } });
}

app.post('/api/auth/send-verify-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'البريد الإلكتروني مطلوب' });
    const prisma = getPrisma();
    const user = await prisma.user.findFirst({ where: { email, deletedAt: null } });
    if (!user) return res.status(404).json({ error: 'إذا كان الحساب موجوداً، تم إرسال التعليمات' });
    const code = genEmailCode();
    await prisma.user.update({
      where: { id: user.id },
      data: { emailCode: code, emailCodeExpiry: new Date(Date.now() + EMAIL_CODE_TTL) }
    });
    const sent = await emailService.sendVerificationEmail(email, user.name, code);
    res.json({ success: true, emailSent: sent });
  } catch (e) { console.error('send-verify-code error:', e); res.status(500).json({ error: 'تعذر إرسال الكود' }); }
});

app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'البريد والكود مطلوبان' });
    const prisma = getPrisma();
    const user = await prisma.user.findFirst({ where: { email, deletedAt: null } });
    if (!user) return res.status(404).json({ error: 'إذا كان الحساب موجوداً، تم إرسال التعليمات' });
    if (user.emailVerified) return res.json({ success: true });
    if (!user.emailCode || !user.emailCodeExpiry || new Date() > user.emailCodeExpiry)
      return res.status(400).json({ error: 'الكود غير صالح أو منتهي الصلاحية' });
    if (String(user.emailCode) !== String(code)) return res.status(400).json({ error: 'الكود غير صحيح' });
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, emailCode: null, emailCodeExpiry: null }
    });
    if (fbAuth && user.uid) {
      try { await fbAuth.updateUser(user.uid, { emailVerified: true }); } catch (e) { console.error('fb verify update error:', e.message); }
    }
    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    req.session = { user: sessionUser(updated), darkMode: req.session.darkMode || false };
    res.json({ success: true });
  } catch (e) { console.error('verify-email error:', e); res.status(500).json({ error: 'تعذر تأكيد البريد' }); }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'البريد الإلكتروني مطلوب' });
    const prisma = getPrisma();
    const user = await prisma.user.findFirst({ where: { email, deletedAt: null } });
    if (!user) return res.status(404).json({ error: 'إذا كان الحساب موجوداً، تم إرسال التعليمات' });
    const code = genEmailCode();
    await prisma.user.update({
      where: { id: user.id },
      data: { resetCode: code, resetCodeExpiry: new Date(Date.now() + EMAIL_CODE_TTL) }
    });
    const sent = await emailService.sendResetPasswordEmail(email, user.name, code);
    res.json({ success: true, emailSent: sent });
  } catch (e) { console.error('forgot-password error:', e); res.status(500).json({ error: 'تعذر إرسال الكود' }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    const prisma = getPrisma();
    const user = await prisma.user.findFirst({ where: { email, deletedAt: null } });
    if (!user) return res.status(404).json({ error: 'إذا كان الحساب موجوداً، تم إرسال التعليمات' });
    if (!user.resetCode || !user.resetCodeExpiry || new Date() > user.resetCodeExpiry)
      return res.status(400).json({ error: 'الكود غير صالح أو منتهي الصلاحية' });
    if (String(user.resetCode) !== String(code)) return res.status(400).json({ error: 'الكود غير صحيح' });
    const passwordHash = await scryptHash(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, resetCode: null, resetCodeExpiry: null }
    });
    if (fbAuth && user.uid) {
      try { await fbAuth.updateUser(user.uid, { password: newPassword }); } catch (e) { console.error('fb password update error:', e.message); }
    }
    res.json({ success: true });
  } catch (e) { console.error('reset-password error:', e); res.status(500).json({ error: 'تعذر تغيير كلمة المرور' }); }
});

app.post('/api/auth/firebase-admin-login', async (req, res) => {
  try {
    const { idToken } = req.body;
    const decoded = await fbAuth.verifyIdToken(idToken);
    const prisma = getPrisma();
    const user = await prisma.user.findFirst({
      where: { OR: [{ id: decoded.uid }, { uid: decoded.uid }], role: 'admin', deletedAt: null }
    });
    if (!user) return res.status(403).json({ error: 'غير مصرح بالدخول' });
    req.session = { user: sessionUser(user), darkMode: req.session.darkMode || false };
    res.json({ success: true, redirect: '/admin' });
  } catch (e) {
    console.error('[Firebase Admin Login Error]', e);
    res.status(401).json({ error: getFirebaseErrorMessage(e) });
  }
});

// Public legal pages (used for Zoom app publication)
app.get('/privacy', (req, res) => res.render('privacy'));
app.get('/terms', (req, res) => res.render('terms'));
app.get('/docs', (req, res) => res.render('docs'));
app.get('/code', (req, res) => res.render('code'));
// old /support route removed — replaced by new ticket system below

function landingHTML(themeCss, themeAccent) {
  return '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
    '<meta name="theme-color" content="' + (themeAccent || '#F59E0B') + '">' +
    '<title>المُميز — منصة تعليم اللغة العربية</title>' +
    '<script>var ls=localStorage.getItem("lughati-theme");if(ls){document.documentElement.setAttribute("data-theme",ls)}else{var m=window.matchMedia("(prefers-color-scheme:dark)");document.documentElement.setAttribute("data-theme",m.matches?"dark":"light");m.addEventListener("change",function(e){if(!localStorage.getItem("lughati-theme"))document.documentElement.setAttribute("data-theme",e.matches?"dark":"light")})}</script>' +
    '<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&family=Aref+Ruqaa:wght@400;700&display=swap" rel="stylesheet">' +
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">' +
    '<style>' +
    '[data-theme="dark"]{--noise:rgba(255,255,255,0.008);--primary:#F59E0B;--accent:#F59E0B;--accent-glow:rgba(245,158,11,0.18);--gold-gradient:linear-gradient(135deg,#F59E0B,#D97706);--btn-text:#111;--bg:#0F172A;--card:#1E293B;--card-alt:#111827;--glass-bg:rgba(255,255,255,0.06);--glass-border:rgba(255,255,255,0.1);--glass-blur:24px;--text:#F1F5F9;--text-light:#94A3B8;--text-muted:#64748B;--border:rgba(255,255,255,0.06);--radius:14px;--radius-lg:18px;--radius-xl:24px;--shadow:0 2px 8px rgba(0,0,0,0.25);--shadow-md:0 4px 16px rgba(0,0,0,0.3);--shadow-lg:0 8px 30px rgba(0,0,0,0.35);--transition:all 0.3s cubic-bezier(0.4,0,0.2,1)}' +
    '[data-theme="light"]{--noise:rgba(0,0,0,0.012);--primary:#F59E0B;--accent:#F59E0B;--accent-glow:rgba(245,158,11,0.15);--gold-gradient:linear-gradient(135deg,#F59E0B,#D97706);--btn-text:#fff;--bg:#FFF9F1;--card:#FFFFFF;--card-alt:#f5f5f5;--glass-bg:rgba(255,255,255,0.85);--glass-border:rgba(0,0,0,0.06);--glass-blur:20px;--text:#111111;--text-light:#666666;--text-muted:#9A8A7A;--border:#E8E8E8;--radius:14px;--radius-lg:18px;--radius-xl:24px;--shadow:0 2px 8px rgba(0,0,0,0.06);--shadow-md:0 4px 16px rgba(0,0,0,0.08);--shadow-lg:0 8px 30px rgba(0,0,0,0.1);--transition:all 0.3s cubic-bezier(0.4,0,0.2,1)}' +
    '*{box-sizing:border-box;margin:0;padding:0;scrollbar-width:none;-ms-overflow-style:none}*::-webkit-scrollbar{display:none}' +
    'html,body{height:100%}' +
    'body{font-family:Cairo,Tahoma,sans-serif;background:var(--bg);color:var(--text);overflow-x:hidden}' +

    '.lp-noise{position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:0;opacity:0.35;background:repeating-linear-gradient(0deg,transparent,transparent 2px,var(--noise,rgba(255,255,255,0.008)) 2px,var(--noise,rgba(255,255,255,0.008)) 4px),repeating-linear-gradient(90deg,transparent,transparent 2px,var(--noise,rgba(255,255,255,0.008)) 2px,var(--noise,rgba(255,255,255,0.008)) 4px)}' +
    '.lp-orb{position:fixed;border-radius:50%;pointer-events:none;z-index:0}' +
    '.lp-orb1{width:400px;height:400px;background:var(--accent);opacity:0.07;filter:blur(120px);top:-20%;right:-20%;animation:float1 30s ease-in-out infinite}' +
    '.lp-orb2{width:350px;height:350px;background:var(--primary);opacity:0.05;filter:blur(100px);bottom:-20%;left:-20%;animation:float2 35s ease-in-out infinite}' +
    '.lp-orb3{width:250px;height:250px;background:var(--accent);opacity:0.04;filter:blur(80px);top:40%;left:50%;animation:float3 25s ease-in-out infinite}' +
    '@keyframes float1{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(50px,-50px) scale(1.15)}66%{transform:translate(-40px,40px) scale(0.9)}}' +
    '@keyframes float2{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(-45px,55px) scale(1.2)}66%{transform:translate(40px,-30px) scale(0.95)}}' +
    '@keyframes float3{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(25px,-25px) scale(1.25)}}' +

    '@keyframes fadeDown{from{opacity:0;transform:translateY(-20px)}to{opacity:1;transform:translateY(0)}}' +
    '@keyframes fade{from{opacity:0}to{opacity:1}}' +
    '@keyframes scaleFade{from{opacity:0;transform:scale(0.93)}to{opacity:1;transform:scale(1)}}' +
    '@keyframes fadeUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}' +

    '.lp-header{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-radius:var(--radius-xl);transition:all 0.4s ease}' +
    '.lp-header.scrolled{background:var(--glass-bg);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}' +
    '.lp-logo{display:flex;align-items:center;gap:10px;font-family:\'Aref Ruqaa\',serif;font-size:20px;font-weight:700;color:var(--accent);text-decoration:none}' +
    '.lp-logo i{font-size:22px}' +
    '.lp-header-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 22px;border-radius:var(--btn-radius,var(--radius));font-size:13px;font-weight:700;cursor:pointer;transition:all 0.3s cubic-bezier(0.4,0,0.2,1);text-decoration:none;border:none;font-family:inherit}' +
    '.lp-header-btn.lp-btn-primary{background:var(--gold-gradient);color:var(--btn-text,#111);box-shadow:var(--shadow-accent)}' +
    '.lp-header-btn.lp-btn-primary:hover{transform:translateY(-2px);box-shadow:0 12px 30px var(--accent-glow)}' +
    '.lp-header-btn.lp-btn-primary:active{transform:translateY(0) scale(0.98)}' +

    '.lp-hero{position:relative;z-index:1;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:100px 20px 40px;text-align:center}' +
    '.lp-hero-inner{display:flex;flex-direction:column;align-items:center;width:100%;max-width:420px}' +

    '.lp-h1{font-family:\'Aref Ruqaa\',serif;font-size:clamp(30px,8vw,52px);font-weight:700;line-height:1.6;color:var(--text);margin-bottom:16px;animation:fadeDown 0.8s ease 0.1s both}' +
    '.lp-h1 .accent{background:var(--gold-gradient-text);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}' +
    '.lp-hero-icon{width:64px;height:64px;border-radius:20px;background:var(--gold-gradient);display:flex;align-items:center;justify-content:center;margin-bottom:20px;box-shadow:0 8px 32px var(--accent-glow);animation:fadeDown 0.8s ease both}' +
    '.lp-hero-icon i{font-size:28px;color:var(--btn-text,#111)}' +

    '.lp-desc{font-size:14px;color:var(--text-light);line-height:1.9;max-width:360px;margin-bottom:32px;animation:fade 0.8s ease 0.2s both}' +

    '.lp-card{width:100%;background:var(--glass-bg);-webkit-backdrop-filter:blur(var(--glass-blur));backdrop-filter:blur(var(--glass-blur));border:1px solid var(--glass-border);border-radius:var(--radius-xl);padding:24px 20px;box-shadow:var(--shadow-lg);animation:scaleFade 0.8s ease 0.35s both}' +

    '.lp-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:54px;border-radius:var(--btn-radius,var(--radius));font-size:15px;font-weight:700;cursor:pointer;transition:all 0.3s cubic-bezier(0.4,0,0.2,1);text-decoration:none;border:none;font-family:inherit}' +
    '.lp-btn-primary{background:var(--gold-gradient);color:var(--btn-text,#111);box-shadow:var(--shadow-accent)}' +
    '.lp-btn-primary:hover{transform:translateY(-2px);box-shadow:0 12px 30px var(--accent-glow)}' +
    '.lp-btn-primary:active{transform:translateY(0) scale(0.98)}' +
    '.lp-btn-outline{background:transparent;color:var(--accent);border:2px solid var(--accent)}' +
    '.lp-btn-outline:hover{background:var(--accent-glow);border-color:var(--accent);color:var(--accent);transform:translateY(-2px);box-shadow:0 8px 25px var(--accent-glow)}' +
    '.lp-btn-outline:active{transform:scale(0.98)}' +
    '.lp-btn+.lp-btn{margin-top:12px}' +

    '.lp-guest{display:inline-flex;align-items:center;gap:6px;margin-top:16px;font-size:14px;color:var(--text-muted);text-decoration:none;transition:color 0.3s ease}' +
    '.lp-guest:hover{color:var(--accent)}' +
    '.lp-guest i{font-size:12px}' +

    '.lp-features{display:flex;gap:10px;width:100%;max-width:420px;margin:32px auto 0;animation:fadeUp 0.8s ease 0.6s both}' +
    '.lp-feat{flex:1;background:var(--card);border-radius:var(--radius-lg);padding:18px 8px;border:1px solid var(--border);text-align:center;transition:all 0.3s ease}' +
    '.lp-feat:hover{border-color:var(--accent);transform:translateY(-2px)}' +
    '.lp-feat i{font-size:22px;color:var(--accent);display:block;margin-bottom:8px}' +
    '.lp-feat span{font-size:12px;color:var(--text-light);font-weight:600;display:block;line-height:1.4}' +

    '.lp-divider{display:flex;align-items:center;gap:12px;width:100%;margin:24px 0 16px}' +
    '.lp-divider::before,.lp-divider::after{content:\'\';flex:1;height:1px;background:var(--border)}' +
    '.lp-divider span{font-size:13px;color:var(--text-muted);white-space:nowrap;flex-shrink:0}' +

    '.lp-fab{position:fixed;bottom:24px;left:24px;z-index:99;width:56px;height:56px;border-radius:50%;background:var(--gold-gradient);color:var(--btn-text,#111);display:flex;align-items:center;justify-content:center;text-decoration:none;box-shadow:0 4px 20px var(--accent-glow);animation:fadeUp 0.8s ease 1.3s both;transition:all 0.3s cubic-bezier(0.4,0,0.2,1)}' +
    '.lp-fab:hover{transform:scale(1.1);box-shadow:0 8px 30px var(--accent-glow)}' +
    '.lp-fab:active{transform:scale(0.95)}' +
    '.lp-fab i{font-size:22px}' +
    '.lp-fab-pulse{animation:pulse 2s ease-in-out 2s infinite}' +
    '@keyframes pulse{0%,100%{box-shadow:0 4px 20px var(--accent-glow)}50%{box-shadow:0 4px 30px var(--accent-glow),0 0 0 12px rgba(245,158,11,0.08)}}' +

    '.lp-modal{position:fixed;inset:0;z-index:200;display:none;align-items:center;justify-content:center;padding:20px;animation:fade 0.3s ease both}' +
    '.lp-modal.open{display:flex}' +
    '.lp-modal-bg{position:absolute;inset:0;background:rgba(0,0,0,0.6);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}' +
    '.lp-modal-box{position:relative;width:100%;max-width:500px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-xl);padding:32px 24px;box-shadow:var(--shadow-lg);animation:scaleFade 0.3s ease both;max-height:90vh;overflow-y:auto}' +
    '.lp-modal-close{position:absolute;top:12px;left:12px;width:36px;height:36px;border-radius:50%;border:none;background:var(--glass-bg);color:var(--text);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.3s ease}' +
    '.lp-modal-close:hover{background:var(--accent-glow);color:var(--accent)}' +
    '.lp-modal h2{font-family:\'Aref Ruqaa\',serif;font-size:24px;margin-bottom:4px}' +
    '.lp-modal p{font-size:14px;color:var(--text-light);margin-bottom:20px;line-height:1.7}' +
    '.lp-modal .form-group{margin-bottom:14px}' +
    '.lp-modal label{display:block;font-size:13px;font-weight:600;color:var(--text-light);margin-bottom:6px}' +
    '.lp-modal input,.lp-modal textarea{width:100%;padding:12px 14px;border-radius:var(--radius);border:1px solid var(--border);background:var(--glass-bg);color:var(--text);font-size:14px;font-family:inherit;outline:none;transition:border-color 0.3s ease}' +
    '.lp-modal input:focus,.lp-modal textarea:focus{border-color:var(--accent)}' +
    '.lp-modal textarea{min-height:90px;resize:vertical}' +
    '.lp-modal .lp-btn{margin-top:8px}' +
    '.lp-modal .msg{padding:12px 16px;border-radius:var(--radius);font-size:13px;margin-bottom:14px;display:none}' +
    '.lp-modal .msg.success{display:block;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.2);color:#4ade80}' +
    '.lp-modal .msg.error{display:block;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#f87171}' +

    '@media(prefers-reduced-motion:reduce){.lp-h1,.lp-desc,.lp-card,.lp-guest,.lp-features,.lp-orb1,.lp-orb2,.lp-orb3{animation:none}}' +

    '@media(min-width:420px){.lp-header{padding:14px 24px}.lp-hero-inner{max-width:440px}.lp-h1{font-size:clamp(34px,8vw,52px)}}' +
    '@media(min-width:768px){' +
    '.lp-header{padding:16px 40px}.lp-logo{font-size:22px}.lp-logo i{font-size:24px}.lp-header-btn{height:44px;font-size:14px}' +
    '.lp-hero{padding:80px 40px}.lp-hero-inner{max-width:480px}' +
    '.lp-h1{font-size:clamp(40px,5vw,56px);margin-bottom:20px}.lp-desc{font-size:15px;max-width:400px;margin-bottom:36px}' +
    '.lp-card{padding:32px 28px}.lp-btn{height:58px;font-size:16px}' +
    '.lp-features{gap:12px;margin-top:40px}.lp-feat{padding:22px 12px}.lp-feat i{font-size:26px}.lp-feat span{font-size:13px}}' +
    '</style>' +
    '<style>' + (themeCss || '') + '</style>' +
    '</head><body>' +
    '<div class="lp-noise"></div>' +
    '<div class="lp-orb lp-orb1"></div>' +
    '<div class="lp-orb lp-orb2"></div>' +
    '<div class="lp-orb lp-orb3"></div>' +
    '<header class="lp-header" id="lpHeader"><a href="/" class="lp-logo"><i class="fas fa-graduation-cap"></i>المُميز</a><a href="/login" class="lp-header-btn lp-btn-primary">ابدأ الآن</a></header>' +
    '<section class="lp-hero">' +
    '<div class="lp-hero-inner">' +
    '<div class="lp-hero-icon"><i class="fas fa-graduation-cap"></i></div>' +
    '<h1 class="lp-h1">أتقن اللغة العربية<br>مع <span class="accent">الأستاذ محمد عفيفي</span></h1>' +
    '<p class="lp-desc">رحلة متكاملة تجمع بين الشرح المبسط والتقييم الذكي والمتابعة المستمرة — لتحقق التفوق في أدق التفاصيل</p>' +
    '<div class="lp-card">' +
    '<a href="/register" class="lp-btn lp-btn-primary"><i class="fas fa-user-plus"></i> إنشاء حساب جديد</a>' +
    '<div class="lp-divider"><span>أو</span></div>' +
    '<a href="/login" class="lp-btn lp-btn-outline"><i class="fas fa-arrow-left"></i> تسجيل الدخول</a>' +
    '<a href="/demo" class="lp-guest"><i class="fas fa-eye"></i> تصفح كزائر</a>' +
    '</div>' +
    '<div class="lp-features">' +
    '<div class="lp-feat"><i class="fas fa-play-circle"></i><span>شاهد الدروس</span></div>' +
    '<div class="lp-feat"><i class="fas fa-question-circle"></i><span>اختبر نفسك</span></div>' +
    '<div class="lp-feat"><i class="fas fa-chart-line"></i><span>تابع تقدمك</span></div>' +
    '</div>' +
    '</div>' +
    '</section>' +
    '<button class="lp-fab lp-fab-pulse" onclick="document.getElementById(\'supportModal\').classList.add(\'open\')" title="الدعم الفني"><i class="fas fa-headset"></i></button>' +
    '<div class="lp-modal" id="supportModal"><div class="lp-modal-bg" onclick="document.getElementById(\'supportModal\').classList.remove(\'open\')"></div><div class="lp-modal-box"><button class="lp-modal-close" onclick="document.getElementById(\'supportModal\').classList.remove(\'open\')"><i class="fas fa-times"></i></button><h2>الدعم الفني</h2><p>تواصل مع فريق الدعم — سنرد عليك في أقرب وقت ممكن</p><div id="lpMsgBox" class="msg"></div><form id="ticketForm" onsubmit="return submitTicket(event)"><div class="form-group"><label>الاسم</label><input type="text" id="tName" required placeholder="الاسم الثلاثي"></div><div class="form-group"><label>البريد الإلكتروني</label><input type="email" id="tEmail" required placeholder="example@mail.com" dir="ltr"></div><div class="form-group"><label>رقم الهاتف (اختياري)</label><input type="tel" id="tPhone" placeholder="0100 000 0000" dir="ltr"></div><div class="form-group"><label>الموضوع</label><input type="text" id="tSubject" required placeholder="مشكلة في تسجيل الدخول..."></div><div class="form-group"><label>الرسالة</label><textarea id="tMessage" required placeholder="اشرح مشكلتك بالتفصيل..."></textarea></div><button type="submit" class="lp-btn lp-btn-primary" id="tBtn"><i class="fas fa-paper-plane"></i> إرسال التذكرة</button></form></div></div>' +
    '<script>(function(){var h=document.getElementById(\'lpHeader\'),t=false;function u(){var s=window.scrollY||window.pageYOffset;h.classList[s>20?\'add\':\'remove\'](\'scrolled\');t=false}window.addEventListener(\'scroll\',function(){if(!t){requestAnimationFrame(u);t=true}},{passive:true});' +
    'window.submitTicket=function(e){e.preventDefault();var b=document.getElementById(\'tBtn\');b.disabled=true;b.innerHTML=\'<i class="fas fa-spinner fa-spin"></i> جاري الإرسال...\';' +
    'fetch("/support/submit",{method:"POST",headers:{"Content-Type":"application/json"},' +
    'body:JSON.stringify({name:document.getElementById("tName").value,email:document.getElementById("tEmail").value,' +
    'phone:document.getElementById("tPhone").value,subject:document.getElementById("tSubject").value,' +
    'message:document.getElementById("tMessage").value})}).then(function(r){return r.json()}).then(function(d){' +
    'if(d.success){document.getElementById("lpMsgBox").className="msg success";' +
    'document.getElementById("lpMsgBox").innerHTML=\'<i class="fas fa-check-circle"></i> تم إرسال تذكرتك بنجاح! سنرد عليك عبر البريد الإلكتروني.\';' +
    'document.getElementById("ticketForm").style.display="none"}else{' +
    'document.getElementById("lpMsgBox").className="msg error";' +
    'document.getElementById("lpMsgBox").textContent=d.error||"حدث خطأ أثناء الإرسال"}' +
    'b.disabled=false;b.innerHTML=\'<i class="fas fa-paper-plane"></i> إرسال التذكرة\'}).catch(function(e){' +
    'document.getElementById("lpMsgBox").className="msg error";' +
    'document.getElementById("lpMsgBox").textContent="حدث خطأ في الاتصال، حاول مرة أخرى";' +
    'b.disabled=false;b.innerHTML=\'<i class="fas fa-paper-plane"></i> إرسال التذكرة\'});return false})();</script>' +
    '</body></html>';
}

// GET / — Landing page (public) or redirect to dashboard (logged in)
app.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  if (req.session.user) {
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    else if (req.session.user.role === 'parent') return res.redirect('/parent/dashboard');
    else return res.redirect('/student');
  }
  const themeCss = await getThemeCss();
  const theme = await readData('themeConfig');
  const themeAccent = theme && theme.accent ? theme.accent : '#F59E0B';
  res.send(landingHTML(themeCss, themeAccent));
});

app.get('/demo', (req, res) => {
  req.session.demoMode = true;
  req.session.user = sessionUser({ name: 'زائر', role: 'guest', grade: '' });
  res.redirect('/student');
});

app.get('/courses', async (req, res) => {
  const courses = await readData('courses');
  res.render('public/courses', { courses, title: 'المحاضرات - المُميز' });
});

app.get('/subscriptions', async (req, res) => {
  const subscriptions = await readData('subscriptions');
  res.render('public/subscriptions', { subscriptions, title: 'الاشتراكات - المُميز' });
});

app.get('/contact', (req, res) => {
  res.render('public/contact', { title: 'تواصل معنا - المُميز' });
});

app.get('/login', (req, res) => {
  if (req.session.user) return req.session.user.role === 'admin' ? res.redirect('/admin') : res.redirect('/student');
  res.render('auth/login', { title: 'تسجيل الدخول - المُميز', error: null });
});

app.get('/parent-login', (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    if (req.session.user.role === 'parent') return res.redirect('/parent/dashboard');
    return res.redirect('/student');
  }
  res.render('auth/login', { title: 'تسجيل دخول ولي الأمر - المُميز', error: null, parentLogin: true });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const prisma = getPrisma();
  const user = await prisma.user.findFirst({ where: { email, deletedAt: null } });
  if (!user) return res.render('auth/login', { title: 'تسجيل الدخول - المُميز', error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) return res.render('auth/login', { title: 'تسجيل الدخول - المُميز', error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
  if (user.emailVerified === false) {
    return res.render('auth/login', { title: 'تسجيل الدخول - المُميز', error: 'يرجى تأكيد بريدك الإلكتروني أولاً. تم إرسال كود التأكيد إلى بريدك.' });
  }
  if (typeof user.passwordHash === 'string' && !user.passwordHash.startsWith('scrypt$') && password) {
    const hash = await scryptHash(password);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hash } });
    user.passwordHash = hash;
  }
  req.session = { user: sessionUser(user), darkMode: req.session.darkMode || false };
  if (user.role === 'admin') return res.redirect('/admin');
  res.redirect('/student');
});

app.get('/register', (req, res) => {
  if (req.session.user && !req.session.demoMode) return req.session.user.role === 'admin' ? res.redirect('/admin') : res.redirect('/student');
  res.render('auth/register', { title: 'إنشاء حساب - المُميز', error: null });
});

app.post('/register', async (req, res) => {
  const { name, email, phone, parentPhone, grade, stage, governorate, password, referralCode } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.render('auth/register', { title: 'إنشاء حساب - المُميز', error: 'البريد الإلكتروني غير صالح' });
  if (!password || password.length < 6) return res.render('auth/register', { title: 'إنشاء حساب - المُميز', error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  const prisma = getPrisma();
  const existing = await prisma.user.findFirst({ where: { email, deletedAt: null } });
  if (existing) return res.render('auth/register', { title: 'إنشاء حساب - المُميز', error: 'حدث خطأ في التسجيل، يرجى المحاولة مرة أخرى' });
  const uid = uuidv4();
  const passwordHash = password ? await scryptHash(password) : '';
  const newUser = {
    id: uid, uid, name, email, phone: phone || '', parentPhone: parentPhone || '',
    grade, stage: stage || '', governorate: governorate || '', role: 'student',
    subscriptionStatus: 'inactive',
    referralCode: 'REF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    referredBy: referralCode || '',
    referralDiscount: 0,
    passwordHash,
    createdAt: new Date(), lastLogin: new Date(),
  };
  if (referralCode) {
    const referrer = await prisma.user.findFirst({ where: { referralCode, deletedAt: null } });
    if (referrer) {
      newUser.referredBy = referrer.id;
      const settingsRef = await readData('settings') || {};
      const refDiscount = settingsRef.referralDiscount != null ? settingsRef.referralDiscount : 25;
      await prisma.referral.create({
        data: { referrerId: referrer.id, referredId: uid, discount: refDiscount, code: referralCode }
      }).catch(() => {});
    }
  }
  await prisma.user.create({ data: newUser });
  req.session = { user: sessionUser(newUser), darkMode: req.session.darkMode || false };
  res.redirect('/student');
});

app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

app.post('/api/toggle-dark-mode', (req, res) => {
  req.session.darkMode = !req.session.darkMode;
  res.json({ darkMode: req.session.darkMode });
});

/* ===================== SUPPORT TICKET SYSTEM ===================== */

function requireSupport(req, res, next) {
  if (req.session.supportAccess) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/support/login');
}

// GET /support — public ticket form
app.get('/support', function(req, res) {
  var u = req.session && req.session.user;
  var isStudent = u && u.role === 'student';
  var name = u && (u.name || '');
  var email = u && (u.email || '');
  var phone = u && (u.phone || '');
  var infoRow = isStudent
    ? '<div style="background:var(--input-bg);border:1px solid var(--input-border);border-radius:12px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:var(--text-light);">' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;"><strong>' + escHtml(name) + '</strong>' +
      (email ? '<span style="color:var(--text-muted);">|</span> <span dir="ltr">' + escHtml(email) + '</span>' : '') +
      (phone ? '<span style="color:var(--text-muted);">|</span> <span dir="ltr">' + escHtml(phone) + '</span>' : '') +
      '</div><div style="font-size:12px;color:var(--text-muted);margin-top:4px;"><i class="fas fa-check-circle" style="color:#4ade80;font-size:11px;"></i> سيتم إرفاق بيانات حسابك تلقائيًا</div></div>' +
      '<input type="hidden" id="tName" value="' + escHtml(name) + '">' +
      '<input type="hidden" id="tEmail" value="' + escHtml(email) + '">' +
      '<input type="hidden" id="tPhone" value="' + escHtml(phone) + '">'
    : '';
  var nameField = isStudent ? '' :
    '<div class="form-group"><label>الاسم</label><input type="text" id="tName" required placeholder="الاسم الثلاثي"></div>';
  var emailField = isStudent ? '' :
    '<div class="form-group"><label>البريد الإلكتروني</label><input type="email" id="tEmail" required placeholder="example@mail.com" dir="ltr"></div>';
  var phoneField = isStudent ? '' :
    '<div class="form-group"><label>رقم الهاتف (اختياري)</label><input type="tel" id="tPhone" placeholder="0100 000 0000" dir="ltr"></div>';
  res.send(
    '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
    '<script>document.documentElement.setAttribute("data-theme",localStorage.getItem("lughati-theme")||(window.matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light"))</script>' +
    '<title>الدعم الفني — المُميز</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&family=Aref+Ruqaa:wght@400;700&display=swap" rel="stylesheet">' +
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">' +
    '<style>' +
    ':root,[data-theme="dark"]{--bg:#0f172a;--card-bg:rgba(255,255,255,.03);--card-border:rgba(255,255,255,.06);--text:#e2e8f0;--text-light:#94a3b8;--text-muted:#64748b;--input-bg:rgba(255,255,255,.04);--input-border:rgba(255,255,255,.08);--shadow:rgba(245,158,11,.25);}' +
    '[data-theme="light"]{--bg:#f4f4f6;--card-bg:#fff;--card-border:#e0e0e0;--text:#111;--text-light:#555;--text-muted:#888;--input-bg:#f8f8f8;--input-border:#ddd;--shadow:rgba(245,158,11,.25);}' +
    '*{box-sizing:border-box;margin:0;padding:0;scrollbar-width:none;-ms-overflow-style:none}*::-webkit-scrollbar{display:none}' +
    'body{font-family:Cairo,Tahoma,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:var(--bg);color:var(--text);padding:20px;}' +
    'body::before{content:"";position:fixed;inset:0;' +
    'background:radial-gradient(ellipse at 50% 0%,rgba(245,158,11,.05) 0%,transparent 60%),' +
    'radial-gradient(ellipse at 80% 100%,rgba(59,130,246,.03) 0%,transparent 50%);' +
    'pointer-events:none;}' +
    '.wrap{width:100%;max-width:540px;position:relative;z-index:1;animation:rise .6s cubic-bezier(.22,1,.36,1) both;}' +
    '@keyframes rise{from{opacity:0;transform:translateY(20px);}to{opacity:1;transform:translateY(0);}}' +
    '.logo{text-align:center;margin-bottom:28px;text-decoration:none;display:block;}' +
    '.logo .ar{font-family:\'Aref Ruqaa\',serif;font-size:36px;background:linear-gradient(135deg,#FBBF24,#D97706);' +
    '-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}' +
    '.logo span{display:block;font-size:13px;color:var(--text-muted);margin-top:2px;}' +
    '.card{background:var(--card-bg);border:1px solid var(--card-border);border-radius:20px;padding:36px 32px;}' +
    '.card h2{font-size:22px;font-weight:700;margin-bottom:4px;}' +
    '.card p{font-size:14px;color:var(--text-light);margin-bottom:24px;line-height:1.7;}' +
    '.form-group{margin-bottom:16px;}' +
    'label{display:block;font-size:13px;font-weight:600;color:var(--text-light);margin-bottom:6px;}' +
    'input,textarea{width:100%;padding:12px 16px;border-radius:12px;border:1px solid var(--input-border);' +
    'background:var(--input-bg);color:var(--text);font-size:14px;font-family:Cairo,Tahoma,sans-serif;' +
    'transition:border-color .2s;outline:none;}' +
    'input:focus,textarea:focus{border-color:#F59E0B;}' +
    'textarea{min-height:100px;resize:vertical;}' +
    '.btn{width:100%;padding:14px;border-radius:12px;border:none;font-size:15px;font-weight:700;' +
    'font-family:Cairo,Tahoma,sans-serif;cursor:pointer;transition:all .3s;display:flex;align-items:center;justify-content:center;gap:8px;}' +
    '.btn-primary{background:linear-gradient(135deg,#F59E0B,#D97706);color:#fff;box-shadow:0 4px 20px var(--shadow);}' +
    '.btn-primary:hover{transform:translateY(-2px);box-shadow:0 8px 30px var(--shadow);}' +
    '.btn-secondary{background:rgba(255,255,255,.06);color:var(--text);}[data-theme="light"] .btn-secondary{background:rgba(0,0,0,.04);}' +
    '.btn-secondary:hover{background:rgba(255,255,255,.1);}[data-theme="light"] .btn-secondary:hover{background:rgba(0,0,0,.08);}' +
    '.msg{padding:12px 16px;border-radius:12px;font-size:13px;margin-bottom:16px;display:none;}' +
    '.msg.success{display:block;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.2);color:#4ade80;}' +
    '.msg.error{display:block;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);color:#f87171;}' +
    '.foot{text-align:center;margin-top:16px;font-size:13px;color:var(--text-muted);}' +
    '.top-btn{display:block;text-align:left;margin-bottom:12px;}' +
    '.top-btn a{display:inline-flex;align-items:center;gap:6px;padding:10px 20px;border-radius:12px;' +
    'background:linear-gradient(135deg,#F59E0B,#D97706);color:#fff;text-decoration:none;font-size:13px;font-weight:700;' +
    'font-family:Cairo,Tahoma,sans-serif;transition:all .3s;box-shadow:0 4px 20px var(--shadow);}' +
    '.top-btn a:hover{transform:translateY(-2px);box-shadow:0 8px 30px var(--shadow);}' +
    '</style></head><body>' +
    '<div class="wrap">' +
    '<div class="top-btn"><a href="/support/my-tickets"><i class="fas fa-search"></i> تذاكري</a></div>' +
    '<a href="/" class="logo"><span class="ar">المُميز</span><span>منصة تعليم اللغة العربية</span></a>' +
    '<div class="card">' +
    '<h2>الدعم الفني</h2>' +
    '<p>تواصل مع فريق الدعم الفني — سنرد عليك في أقرب وقت ممكن</p>' +
    '<div id="msgBox" class="msg"></div>' +
    '<form id="ticketForm" onsubmit="return submitTicket(event)">' +
    infoRow +
    nameField +
    emailField +
    phoneField +
    '<div class="form-group"><label>الموضوع</label><input type="text" id="tSubject" required placeholder="مشكلة في تسجيل الدخول..."></div>' +
    '<div class="form-group"><label>الرسالة</label><textarea id="tMessage" required placeholder="اشرح مشكلتك بالتفصيل..."></textarea></div>' +
    '<button type="submit" class="btn btn-primary" id="tBtn"><i class="fas fa-paper-plane"></i> إرسال التذكرة</button>' +
    '</form>' +
    '</div>' +
    '</div>' +
    '<script>' +
    'function submitTicket(e){e.preventDefault();var b=document.getElementById("tBtn");b.disabled=true;b.innerHTML=\'<i class="fas fa-spinner fa-spin"></i> جاري الإرسال...\';' +
    'fetch("/support/submit",{method:"POST",headers:{"Content-Type":"application/json"},' +
    'body:JSON.stringify({name:document.getElementById("tName").value,email:document.getElementById("tEmail").value,' +
    'phone:document.getElementById("tPhone").value,subject:document.getElementById("tSubject").value,' +
    'message:document.getElementById("tMessage").value})}).then(function(r){return r.json()}).then(function(d){' +
    'if(d.success){document.getElementById("msgBox").className="msg success";' +
    'document.getElementById("msgBox").innerHTML=\'<i class="fas fa-check-circle"></i> تم إرسال تذكرتك بنجاح! سنرد عليك عبر البريد الإلكتروني. يمكنك متابعة تذاكرك من <a href="/support/my-tickets" style="color:#4ade80;text-decoration:underline;">هنا</a>.\';' +
    'document.getElementById("ticketForm").reset();}else{document.getElementById("msgBox").className="msg error";' +
    'document.getElementById("msgBox").textContent=d.error||"حدث خطأ، حاول مرة أخرى.";}' +
    '}).catch(function(){document.getElementById("msgBox").className="msg error";' +
    'document.getElementById("msgBox").textContent="حدث خطأ في الاتصال، حاول مرة أخرى.";' +
    '}).finally(function(){b.disabled=false;b.innerHTML=\'<i class="fas fa-paper-plane"></i> إرسال التذكرة\';});return false;}' +
    '</script></body></html>'
  );
});

// POST /support/submit — create ticket
app.post('/support/submit', async (req, res) => {
  try {
    var u = req.session && req.session.user;
    var isStudent = u && u.role === 'student';
    var name = isStudent ? (u.name || '') : req.body.name;
    var email = isStudent ? (u.email || '') : req.body.email;
    var phone = isStudent ? (u.phone || '') : (req.body.phone || '');
    var subject = req.body.subject;
    var message = req.body.message;
    if (!subject || !message) return res.json({ success: false, error: 'يرجى ملء جميع الحقول المطلوبة' });
    if (!isStudent && (!name || !email)) return res.json({ success: false, error: 'يرجى ملء جميع الحقول المطلوبة' });
    var tickets = await readData('supportTickets') || [];
    var ticket = {
      id: 'ticket-' + Date.now() + '-' + Math.random().toString(36).slice(2,7),
      requesterName: name, requesterEmail: email, requesterPhone: phone || '', subject, message,
      status: 'open', createdAt: new Date().toISOString()
    };
    // also save userId if logged in student
    if (isStudent && u && u.id) ticket.userId = u.id;
    tickets.push(ticket);
    await writeData('supportTickets', tickets);
    // notify admins
    try {
      var notifs = await readData('notifications') || [];
      notifs.push({
        id: 'notif-' + Date.now(),
        title: 'تذكرة دعم جديدة',
        body: name + ' — ' + subject,
        target: 'admin', targetValue: '',
        url: '/support/admin/ticket/' + ticket.id
      });
      await writeData('notifications', notifs);
    } catch(e) {}
    // email + push notifications to admins
    try {
      var admins = await getPrisma().user.findMany({ where: { role: 'admin', deletedAt: null } });
      for (var ai=0; ai<admins.length; ai++) {
        var au = admins[ai];
        if (au.email) {
          try {
            var html = '<div style="font-family:Tahoma,Arial,sans-serif;max-width:560px;margin:0 auto;">' +
              '<div style="background:linear-gradient(135deg,#0f1b34,#1a2d50);padding:28px;text-align:center;border-radius:16px 16px 0 0;">' +
              '<div style="color:#F59E0B;font-size:26px;font-weight:bold;">منصة المُميز</div>' +
              '<div style="color:#FBBF24;font-size:13px;margin-top:4px;">Almumayaz Educational Platform</div>' +
              '<div style="width:40px;height:3px;background:linear-gradient(90deg,#F59E0B,#FBBF24);border-radius:2px;margin:12px auto;"></div>' +
              '<div style="color:#fde68a;font-size:16px;margin-top:8px;font-weight:600;">تذكرة دعم جديدة</div></div>' +
              '<div style="padding:28px;background:#fff;border-radius:0 0 16px 16px;color:#374151;">' +
              '<p style="margin:0 0 4px;"><strong>المرسل:</strong> ' + escHtml(name) + '</p>' +
              '<p style="margin:0 0 4px;"><strong>البريد:</strong> ' + escHtml(email) + '</p>' +
              '<p style="margin:0 0 4px;"><strong>الموضوع:</strong> ' + escHtml(subject) + '</p>' +
              (phone ? '<p style="margin:0 0 16px;"><strong>الهاتف:</strong> ' + escHtml(phone) + '</p>' : '') +
              '<div style="padding:16px;background:#f8f8f8;border-right:3px solid #f59e0b;border-radius:8px;margin:0 0 20px;">' +
              '<p style="margin:0;color:#333;line-height:1.9;font-size:14px;">' + escHtml(message).replace(/\n/g,'<br>') + '</p></div>' +
              '<div style="text-align:center;"><a href="https://almumayaz.online/support/admin/ticket/' + ticket.id + '" ' +
              'style="display:inline-block;padding:13px 34px;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;' +
              'text-decoration:none;border-radius:8px;font-size:15px;font-weight:bold;">عرض التذكرة</a></div></div></div>';
            await emailService.sendMail(au.email, '🆕 تذكرة دعم جديدة من ' + name, html);
          } catch(e) { console.error('[support] email notify error:', e.message); }
        }
        if (au.fcmToken) {
          try {
            await admin.messaging().send({
              token: au.fcmToken,
              notification: { title: 'تذكرة دعم جديدة 🆕', body: name + ' — ' + subject },
              data: { url: '/support/admin/ticket/' + ticket.id }
            });
            fcmLog.add({ userId: au.id, title: 'تذكرة دعم', messageId: 'sent', success: true, error: null });
          } catch(e) { fcmLog.add({ userId: au.id, title: 'تذكرة دعم', messageId: null, success: false, error: e.code || e.message }); }
        }
      }
    } catch(e) { console.error('[support] notify admins error:', e.message); }
    res.json({ success: true, ticketId: ticket.id });
  } catch (e) { res.json({ success: false, error: 'حدث خطأ، حاول مرة أخرى.' }); }
});

// GET /support/login — support login page
app.get('/support/login', function(req, res) {
  if (req.session.supportAccess) return res.redirect('/support/admin');
  res.send(
    '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
    '<script>document.documentElement.setAttribute("data-theme",localStorage.getItem("lughati-theme")||(window.matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light"))</script>' +
    '<title>دخول الدعم الفني — المُميز</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&family=Aref+Ruqaa:wght@400;700&display=swap" rel="stylesheet">' +
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">' +
    '<style>' +
    ':root,[data-theme="dark"]{--bg:#0f172a;--card-bg:rgba(255,255,255,.03);--card-border:rgba(255,255,255,.06);--text:#e2e8f0;--text-light:#94a3b8;--text-muted:#64748b;--input-bg:rgba(255,255,255,.04);--input-border:rgba(255,255,255,.08);}' +
    '[data-theme="light"]{--bg:#f4f4f6;--card-bg:#fff;--card-border:#e0e0e0;--text:#111;--text-light:#555;--text-muted:#888;--input-bg:#f8f8f8;--input-border:#ddd;}' +
    '*{box-sizing:border-box;margin:0;padding:0;scrollbar-width:none;-ms-overflow-style:none}*::-webkit-scrollbar{display:none}' +
    'body{font-family:Cairo,Tahoma,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:var(--bg);color:var(--text);padding:20px;}' +
    'body::before{content:"";position:fixed;inset:0;' +
    'background:radial-gradient(ellipse at 50% 0%,rgba(245,158,11,.05) 0%,transparent 60%),' +
    'radial-gradient(ellipse at 80% 100%,rgba(59,130,246,.03) 0%,transparent 50%);pointer-events:none;}' +
    '.wrap{width:100%;max-width:420px;position:relative;z-index:1;animation:rise .6s cubic-bezier(.22,1,.36,1) both;}' +
    '@keyframes rise{from{opacity:0;transform:translateY(20px);}to{opacity:1;transform:translateY(0);}}' +
    '.logo{text-align:center;margin-bottom:28px;}' +
    '.logo .ar{font-family:\'Aref Ruqaa\',serif;font-size:32px;background:linear-gradient(135deg,#FBBF24,#D97706);' +
    '-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}' +
    '.card{background:var(--card-bg);border:1px solid var(--card-border);border-radius:20px;padding:36px 32px;}' +
    '.card h2{font-size:20px;font-weight:700;margin-bottom:4px;}' +
    '.card p{font-size:13px;color:var(--text-light);margin-bottom:24px;}' +
    '.form-group{margin-bottom:16px;}' +
    'label{display:block;font-size:13px;font-weight:600;color:var(--text-light);margin-bottom:6px;}' +
    'input{width:100%;padding:12px 16px;border-radius:12px;border:1px solid var(--input-border);' +
    'background:var(--input-bg);color:var(--text);font-size:14px;font-family:Cairo,Tahoma,sans-serif;' +
    'transition:border-color .2s;outline:none;text-align:center;letter-spacing:4px;}' +
    'input:focus{border-color:#F59E0B;}' +
    '.btn{width:100%;padding:14px;border-radius:12px;border:none;font-size:15px;font-weight:700;' +
    'font-family:Cairo,Tahoma,sans-serif;cursor:pointer;transition:all .3s;display:flex;align-items:center;justify-content:center;gap:8px;}' +
    '.btn-primary{background:linear-gradient(135deg,#F59E0B,#D97706);color:#fff;box-shadow:0 4px 20px rgba(245,158,11,.25);}' +
    '.btn-primary:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(245,158,11,.35);}' +
    '.msg{padding:12px;border-radius:12px;font-size:13px;margin-bottom:16px;display:none;}' +
    '.msg.error{display:block;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);color:#f87171;}' +
    '.foot{text-align:center;margin-top:16px;font-size:13px;color:var(--text-muted);}' +
    '.foot a{color:#F59E0B;text-decoration:none;}' +
    '</style></head><body>' +
    '<div class="wrap">' +
    '<div class="logo"><div class="ar">المُميز</div></div>' +
    '<div class="card">' +
    '<h2>دخول الدعم الفني</h2>' +
    '<p>أدخل مفتاح الدعم المقدم من المطور</p>' +
    '<div id="msgBox" class="msg"></div>' +
    '<form onsubmit="return doLogin(event)">' +
    '<div class="form-group"><label>مفتاح الدعم</label><input type="password" id="key" required placeholder="••••••••" dir="ltr"></div>' +
    '<button type="submit" class="btn btn-primary" id="lBtn"><i class="fas fa-lock"></i> دخول</button>' +
    '</form>' +
    '</div>' +
    '<div class="foot"><a href="/support">← العودة إلى الدعم الفني</a> <span style="color:#475569;">&#183;</span> <a href="/support/my-tickets" style="color:#94a3b8;">تذاكري</a></div>' +
    '</div>' +
    '<script>' +
    'function doLogin(e){e.preventDefault();var b=document.getElementById("lBtn");b.disabled=true;b.innerHTML=\'<i class="fas fa-spinner fa-spin"></i> جاري التحقق...\';' +
    'fetch("/support/login",{method:"POST",headers:{"Content-Type":"application/json"},' +
    'body:JSON.stringify({key:document.getElementById("key").value})}).then(function(r){return r.json()}).then(function(d){' +
    'if(d.success){window.location.href="/support/admin";}else{' +
    'document.getElementById("msgBox").className="msg error";document.getElementById("msgBox").textContent=d.error||"مفتاح غير صحيح";' +
    'b.disabled=false;b.innerHTML=\'<i class="fas fa-lock"></i> دخول\';}' +
    '}).catch(function(){document.getElementById("msgBox").className="msg error";' +
    'document.getElementById("msgBox").textContent="حدث خطأ في الاتصال";' +
    'b.disabled=false;b.innerHTML=\'<i class="fas fa-lock"></i> دخول\';});return false;}' +
    '</script></body></html>'
  );
});

// POST /support/login — verify key
app.post('/support/login', async (req, res) => {
  try {
    var settings = await readData('settings') || {};
    var supportKey = settings.supportKey || 'support2024';
    if (req.body.key === supportKey) {
      req.session.supportAccess = true;
      return res.json({ success: true });
    }
    res.json({ success: false, error: 'مفتاح الدعم غير صحيح' });
  } catch (e) { res.json({ success: false, error: 'حدث خطأ' }); }
});

// GET /support/admin — support dashboard
app.get('/support/admin', requireSupport, async (req, res) => {
  try {
    var tickets = await readData('supportTickets') || [];
    tickets.sort(function(a,b){return new Date(b.createdAt)-new Date(a.createdAt);});
    var openTickets = tickets.filter(function(t){return t.status==='open';});
    var closedTickets = tickets.filter(function(t){return t.status==='closed';});
    res.send(
      '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
      '<script>document.documentElement.setAttribute("data-theme",localStorage.getItem("lughati-theme")||(window.matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light"))</script>' +
      '<title>لوحة الدعم الفني — المُميز</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&family=Aref+Ruqaa:wght@400;700&display=swap" rel="stylesheet">' +
      '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">' +
      '<style>' +
      ':root,[data-theme="dark"]{--bg:#0f172a;--card-bg:rgba(255,255,255,.03);--card-border:rgba(255,255,255,.06);--text:#e2e8f0;--text-light:#94a3b8;--text-muted:#64748b;--hover:rgba(245,158,11,.04);}' +
      '[data-theme="light"]{--bg:#f4f4f6;--card-bg:#fff;--card-border:#e0e0e0;--text:#111;--text-light:#555;--text-muted:#888;--hover:rgba(245,158,11,.08);}' +
    '*{box-sizing:border-box;margin:0;padding:0;scrollbar-width:none;-ms-overflow-style:none}*::-webkit-scrollbar{display:none}' +
    'body{font-family:Cairo,Tahoma,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;background:var(--bg);color:var(--text);padding:20px;}' +
    'body::before{content:"";position:fixed;inset:0;' +
    'background:radial-gradient(ellipse at 50% 0%,rgba(245,158,11,.04) 0%,transparent 60%),' +
    'radial-gradient(ellipse at 80% 100%,rgba(59,130,246,.02) 0%,transparent 50%);' +
    'pointer-events:none;}' +
    '.wrap{max-width:900px;margin:0 auto;position:relative;z-index:1;width:100%;}' +
      '.header{display:flex;align-items:center;justify-content:space-between;padding:20px 0;flex-wrap:wrap;gap:12px;}' +
      '.header h1{font-family:\'Aref Ruqaa\',serif;font-size:28px;background:linear-gradient(135deg,#FBBF24,#D97706);' +
      '-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}' +
      '.header .counts{display:flex;gap:12px;font-size:13px;}' +
      '.header .counts span{padding:6px 14px;border-radius:20px;background:var(--card-bg);border:1px solid var(--card-border);}' +
      '.header .counts .open{color:#4ade80;border-color:rgba(34,197,94,.2);background:rgba(34,197,94,.08);}' +
      '.header .counts .closed{color:var(--text-muted);}' +
      '.logout{color:var(--text-muted);text-decoration:none;font-size:13px;padding:8px 16px;border-radius:8px;transition:all .2s;}' +
      '.logout:hover{background:rgba(255,255,255,.06);color:#f87171;}[data-theme="light"] .logout:hover{background:rgba(0,0,0,.04);}' +
      '.ticket{display:block;background:var(--card-bg);border:1px solid var(--card-border);border-radius:16px;' +
      'padding:20px 24px;margin-bottom:14px;text-decoration:none;color:var(--text);transition:all .3s;box-shadow:0 2px 12px rgba(0,0,0,.04);}' +
      '.ticket:hover{border-color:#F59E0B;background:var(--hover);box-shadow:0 8px 30px rgba(0,0,0,.08);}' +
      '.ticket .top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;}' +
      '.ticket .subj{font-size:16px;font-weight:700;}' +
      '.ticket .badge{font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600;}' +
      '.ticket .badge.open{background:rgba(34,197,94,.1);color:#4ade80;border:1px solid rgba(34,197,94,.2);}' +
      '.ticket .badge.closed{background:rgba(100,116,139,.1);color:var(--text-muted);border:1px solid rgba(100,116,139,.2);}' +
      '.ticket .meta{display:flex;gap:16px;font-size:12px;color:var(--text-muted);margin-top:8px;flex-wrap:wrap;}' +
      '.ticket .meta i{margin-left:4px;width:14px;}' +
      '.empty{text-align:center;padding:60px 20px;color:var(--text-muted);}' +
      '.empty i{font-size:48px;margin-bottom:16px;opacity:.3;}' +
      '.empty p{font-size:15px;}' +
      '.tabs{display:flex;gap:8px;margin-bottom:20px;}' +
      '.tabs a{padding:8px 20px;border-radius:20px;font-size:13px;font-weight:600;text-decoration:none;' +
      'background:var(--card-bg);color:var(--text-light);transition:all .2s;}' +
      '.tabs a.active{background:#F59E0B;color:#fff;}' +
      '.tabs a:hover:not(.active){background:rgba(255,255,255,.08);}[data-theme="light"] .tabs a:hover:not(.active){background:rgba(0,0,0,.04);}' +
      '@media(max-width:600px){.header h1{font-size:22px;}}' +
      '</style></head><body>' +
      '<div class="wrap">' +
      '<div class="header">' +
      '<div><h1>الدعم الفني</h1></div>' +
      '<div class="counts">' +
      '<span class="open"><i class="fas fa-circle"></i> ' + openTickets.length + ' مفتوحة</span>' +
      '<span class="closed"><i class="fas fa-check-circle"></i> ' + closedTickets.length + ' مغلقة</span>' +
      '</div>' +
      '<a href="/support/logout" class="logout"><i class="fas fa-sign-out-alt"></i> خروج</a>' +
      '</div>' +
      '<div class="tabs"><a href="/support/admin" class="active">الكل</a></div>' +
      (tickets.length === 0 ?
      '<div class="empty"><i class="fas fa-inbox"></i><p>لا توجد تذاكر دعم حتى الآن</p></div>' :
      tickets.map(function(t) {
        var d = new Date(t.createdAt);
        var ds = d.toLocaleDateString("ar-EG",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
        return '<a href="/support/admin/ticket/' + t.id + '" class="ticket">' +
          '<div class="top"><span class="subj">' + escHtml(t.subject) + '</span>' +
          '<span class="badge ' + t.status + '">' + (t.status==='open'?'مفتوحة':'مغلقة') + '</span></div>' +
          '<div class="meta"><span><i class="fas fa-user"></i>' + escHtml(t.requesterName) + '</span>' +
          '<span><i class="fas fa-clock"></i>' + ds + '</span></div></a>';
      }.bind(this)).join('')
      ) +
      '</div>' +
      '<script>function escHtml(s){if(!s)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}</script>' +
      '</body></html>'
    );
  } catch (e) { res.status(500).send('حدث خطأ في تحميل التذاكر'); }
});

// GET /support/admin/ticket/:id — view single ticket
app.get('/support/admin/ticket/:id', requireSupport, async (req, res) => {
  try {
    var tickets = await readData('supportTickets') || [];
    var ticket = tickets.find(function(t){return t.id===req.params.id;});
    if (!ticket) return res.status(404).send('التذكرة غير موجودة');
    var d = new Date(ticket.createdAt);
    var ds = d.toLocaleDateString("ar-EG",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
    var repliesHtml = '';
    try {
      var prisma = getPrisma();
      var dbReplies = await prisma.ticketReply.findMany({ where: { ticketId: ticket.id }, orderBy: { createdAt: 'asc' } });
      dbReplies.forEach(function(r) {
        var rd = new Date(r.createdAt);
        var rds = rd.toLocaleDateString("ar-EG",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
        var isAdmin = r.senderRole === 'admin';
        var senderName = isAdmin ? 'فريق الدعم' : escHtml(ticket.requesterName);
        repliesHtml += '<div class="reply ' + (isAdmin?'admin':'user') + '">' +
          '<div class="r-header"><span class="r-name">' + senderName + '</span>' +
          '<span class="r-time">' + rds + '</span></div>' +
          '<div class="r-text">' + escHtml(r.message) + '</div></div>';
      });
    } catch(e) {}
    // fallback: legacy embedded replies
    if (!repliesHtml && ticket.replies && ticket.replies.length) {
      ticket.replies.forEach(function(r) {
        var rd = new Date(r.createdAt);
        var rds = rd.toLocaleDateString("ar-EG",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
        repliesHtml += '<div class="reply ' + (r.isAdmin?'admin':'user') + '">' +
          '<div class="r-header"><span class="r-name">' + (r.isAdmin?'فريق الدعم':escHtml(ticket.requesterName)) + '</span>' +
          '<span class="r-time">' + rds + '</span></div>' +
          '<div class="r-text">' + escHtml(r.text) + '</div></div>';
      });
    }
    res.send(
      '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
      '<script>document.documentElement.setAttribute("data-theme",localStorage.getItem("lughati-theme")||(window.matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light"))</script>' +
      '<title>' + escHtml(ticket.subject) + ' — الدعم الفني</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&family=Aref+Ruqaa:wght@400;700&display=swap" rel="stylesheet">' +
      '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">' +
      '<style>' +
      ':root,[data-theme="dark"]{--bg:#0f172a;--card-bg:rgba(255,255,255,.03);--card-border:rgba(255,255,255,.06);--text:#e2e8f0;--text-light:#94a3b8;--text-muted:#64748b;--input-bg:rgba(255,255,255,.04);--input-border:rgba(255,255,255,.08);--border:rgba(255,255,255,.06);}' +
      '[data-theme="light"]{--bg:#f4f4f6;--card-bg:#fff;--card-border:#e0e0e0;--text:#111;--text-light:#555;--text-muted:#888;--input-bg:#f8f8f8;--input-border:#ddd;--border:#e0e0e0;}' +
    '*{box-sizing:border-box;margin:0;padding:0;scrollbar-width:none;-ms-overflow-style:none}*::-webkit-scrollbar{display:none}' +
    'body{font-family:Cairo,Tahoma,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;background:var(--bg);color:var(--text);padding:20px;}' +
    'body::before{content:"";position:fixed;inset:0;' +
    'background:radial-gradient(ellipse at 50% 0%,rgba(245,158,11,.04) 0%,transparent 60%),' +
    'radial-gradient(ellipse at 80% 100%,rgba(59,130,246,.02) 0%,transparent 50%);' +
    'pointer-events:none;}' +
    '.wrap{max-width:700px;margin:0 auto;position:relative;z-index:1;width:100%;}' +
      '.top-bar{display:flex;align-items:center;gap:12px;padding:16px 0;}' +
      '.top-bar a{color:var(--text-muted);text-decoration:none;font-size:14px;}' +
      '.top-bar a:hover{color:#F59E0B;}' +
      '.top-bar h1{font-size:18px;font-weight:700;flex:1;}' +
      '.ticket-card{background:var(--card-bg);border:1px solid var(--card-border);border-radius:16px;padding:24px;margin-bottom:20px;box-shadow:0 2px 12px rgba(0,0,0,.04);}' +
      '.ticket-card .subj{font-size:18px;font-weight:700;margin-bottom:8px;}' +
      '.ticket-card .badge{display:inline-block;font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600;margin-bottom:12px;}' +
      '.ticket-card .badge.open{background:rgba(34,197,94,.1);color:#4ade80;border:1px solid rgba(34,197,94,.2);}' +
      '.ticket-card .badge.closed{background:rgba(100,116,139,.1);color:var(--text-muted);border:1px solid rgba(100,116,139,.2);}' +
      '.ticket-card .meta{font-size:12px;color:var(--text-muted);margin-bottom:12px;}' +
      '.ticket-card .meta span{margin-left:16px;display:inline-block;margin-bottom:4px;}' +
      '.ticket-card .meta i{margin-left:4px;}' +
      '.ticket-card .msg-text{padding:16px;background:var(--input-bg);border-radius:12px;font-size:14px;line-height:1.8;color:var(--text);}' +
      '.replies{margin-bottom:20px;}' +
      '.reply{background:var(--card-bg);border:1px solid var(--card-border);border-radius:12px;padding:16px;margin-bottom:10px;}' +
      '.reply.admin{border-color:rgba(245,158,11,.15);background:rgba(245,158,11,.04);}' +
      '.r-header{display:flex;justify-content:space-between;margin-bottom:8px;font-size:12px;}' +
      '.r-name{font-weight:700;color:#F59E0B;}' +
      '.reply.user .r-name{color:var(--text-light);}' +
      '.r-time{color:var(--text-muted);}' +
      '.r-text{font-size:14px;line-height:1.7;color:var(--text);}' +
      '.reply-box{background:var(--card-bg);border:1px solid var(--card-border);border-radius:16px;padding:20px;}' +
      '.reply-box h3{font-size:15px;margin-bottom:12px;}' +
      'textarea{width:100%;padding:12px 16px;border-radius:12px;border:1px solid var(--input-border);' +
      'background:var(--input-bg);color:var(--text);font-size:14px;font-family:Cairo,Tahoma,sans-serif;' +
      'transition:border-color .2s;outline:none;min-height:80px;resize:vertical;margin-bottom:12px;}' +
      'textarea:focus{border-color:#F59E0B;}' +
      '.actions{display:flex;gap:10px;}' +
      '.btn{padding:12px 24px;border-radius:12px;border:none;font-size:14px;font-weight:700;' +
      'font-family:Cairo,Tahoma,sans-serif;cursor:pointer;transition:all .3s;display:flex;align-items:center;gap:8px;}' +
      '.btn-primary{background:linear-gradient(135deg,#F59E0B,#D97706);color:#fff;}' +
      '.btn-primary:hover{transform:translateY(-2px);}' +
      '.btn-secondary{background:var(--input-bg);color:var(--text);border:1px solid var(--input-border);}' +
      '.btn-secondary:hover{background:rgba(255,255,255,.08);}[data-theme="light"] .btn-secondary:hover{background:rgba(0,0,0,.04);}' +
      '.btn-danger{background:rgba(239,68,68,.1);color:#f87171;border:1px solid rgba(239,68,68,.2);}' +
      '.btn-danger:hover{background:rgba(239,68,68,.2);}' +
      '.btn-delete{background:rgba(220,38,38,.15);color:#ef4444;border:1px solid rgba(220,38,38,.3);}' +
      '.btn-delete:hover{background:rgba(220,38,38,.3);}' +
      '.delete-section{margin-top:20px;padding-top:16px;border-top:1px solid var(--border);text-align:center;}' +
      '</style></head><body>' +
      '<div class="wrap">' +
      '<div class="top-bar"><a href="/support/admin"><i class="fas fa-arrow-right"></i> العودة</a><h1>' + escHtml(ticket.subject) + '</h1></div>' +
      '<div class="ticket-card">' +
      '<div class="subj">' + escHtml(ticket.subject) + '</div>' +
      '<span class="badge ' + ticket.status + '">' + (ticket.status==='open'?'مفتوحة':'مغلقة') + '</span>' +
      '<div class="meta"><span><i class="fas fa-user"></i>' + escHtml(ticket.requesterName) + '</span>' +
      '<span><i class="fas fa-envelope"></i>' + escHtml(ticket.requesterEmail) + '</span>' +
      (ticket.requesterPhone ? '<span><i class="fas fa-phone"></i>' + escHtml(ticket.requesterPhone) + '</span>' : '') +
      '<span><i class="fas fa-clock"></i>' + ds + '</span></div>' +
      '<div class="msg-text">' + escHtml(ticket.message) + '</div>' +
      '</div>' +
      (repliesHtml ? '<div class="replies">' + repliesHtml + '</div>' : '') +
      (ticket.status === 'open' ?
      '<div class="reply-box"><h3>إضافة رد</h3>' +
      '<form onsubmit="return replyTicket(event)">' +
      '<textarea id="replyText" required placeholder="اكتب ردك..."></textarea>' +
      '<div class="actions"><button type="submit" class="btn btn-primary" id="rBtn"><i class="fas fa-reply"></i> إرسال الرد</button>' +
      '<button type="button" class="btn btn-danger" onclick="closeTicket()"><i class="fas fa-check"></i> إغلاق التذكرة</button></div>' +
      '</form></div>' : '') +
      '<div class="delete-section"><button class="btn btn-delete" onclick="deleteTicket()"><i class="fas fa-trash-alt"></i> حذف التذكرة نهائياً</button></div>' +
      '</div>' +
      '<script>' +
      'var ticketId="' + ticket.id + '";' +
      'function replyTicket(e){e.preventDefault();var b=document.getElementById("rBtn");if(!b)return false;' +
      'b.disabled=true;b.innerHTML=\'<i class="fas fa-spinner fa-spin"></i> جاري الإرسال...\';' +
      'fetch("/support/admin/ticket/"+ticketId+"/reply",{method:"POST",headers:{"Content-Type":"application/json"},' +
      'body:JSON.stringify({text:document.getElementById("replyText").value})}).then(function(r){return r.json()}).then(function(d){' +
      'if(d.success){window.location.reload();}else{b.disabled=false;b.innerHTML=\'<i class="fas fa-reply"></i> إرسال الرد\';}' +
      '}).catch(function(){b.disabled=false;b.innerHTML=\'<i class="fas fa-reply"></i> إرسال الرد\';});return false;}' +
      'function closeTicket(){if(!confirm("تأكيد إغلاق التذكرة؟"))return;' +
      'fetch("/support/admin/ticket/"+ticketId+"/close",{method:"POST"}).then(function(r){return r.json()}).then(function(d){' +
      'if(d.success)window.location.reload();});}' +
      'function deleteTicket(){if(!confirm("هل أنت متأكد؟ سيتم حذف التذكرة وجميع الردود نهائياً!"))return;' +
      'fetch("/support/admin/ticket/"+ticketId+"/delete",{method:"POST"}).then(function(r){return r.json()}).then(function(d){' +
      'if(d.success){window.location.href="/support/admin";}else{alert(d.error||"حدث خطأ");}});}' +
      '</script></body></html>'
    );
    function escHtml(s){if(!s)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  } catch (e) { res.status(500).send('حدث خطأ'); }
});

// POST /support/admin/ticket/:id/reply
app.post('/support/admin/ticket/:id/reply', requireSupport, async (req, res) => {
  try {
    var { text } = req.body;
    if (!text) return res.json({ success: false, error: 'الرد مطلوب' });
    var tickets = await readData('supportTickets') || [];
    var idx = tickets.findIndex(function(t){return t.id===req.params.id;});
    if (idx===-1) return res.json({ success: false, error: 'التذكرة غير موجودة' });
    tickets[idx].status = 'open';
    var prisma = getPrisma();
    await prisma.ticketReply.create({
      data: {
        ticketId: tickets[idx].id,
        senderId: req.session.user ? req.session.user.id : null,
        senderRole: 'admin',
        senderName: req.session.user ? (req.session.user.name || 'Support') : 'Support',
        message: text,
        createdAt: new Date()
      }
    });
    await writeData('supportTickets', tickets);
    // notify ticket submitter by email
    try {
      var ticket = tickets[idx];
      var subjLine = '🔄 رد على تذكرتك: ' + ticket.subject;
      var emailHtml = '<div style="font-family:Tahoma,Arial,sans-serif;max-width:560px;margin:0 auto;">' +
        '<div style="background:linear-gradient(135deg,#0f1b34,#1a2d50);padding:28px;text-align:center;border-radius:16px 16px 0 0;">' +
        '<div style="color:#F59E0B;font-size:26px;font-weight:bold;">منصة المُميز</div>' +
        '<div style="color:#FBBF24;font-size:13px;margin-top:4px;">Almumayaz Educational Platform</div>' +
        '<div style="width:40px;height:3px;background:linear-gradient(90deg,#F59E0B,#FBBF24);border-radius:2px;margin:12px auto;"></div>' +
        '<div style="color:#fde68a;font-size:16px;margin-top:8px;font-weight:600;">رد على تذكرتك</div></div>' +
        '<div style="padding:28px;background:#fff;border-radius:0 0 16px 16px;color:#374151;">' +
        '<p style="font-size:16px;margin:0 0 16px;">مرحباً <strong>' + escHtml(ticket.requesterName) + '</strong>،</p>' +
        '<p style="color:#666;margin:0 0 8px;">قام فريق الدعم بالرد على تذكرتك:</p>' +
        '<p style="color:#666;margin:0 0 20px;font-size:13px;">الموضوع: ' + escHtml(ticket.subject) + '</p>' +
        '<div style="padding:16px 18px;background:#f8f8f8;border-radius:8px;border-right:3px solid #f59e0b;margin:0 0 24px;">' +
        '<p style="margin:0;color:#333;line-height:1.9;font-size:14px;">' + escHtml(text).replace(/\n/g,'<br>') + '</p></div>' +
        '<div style="text-align:center;margin:0 0 20px;">' +
        '<a href="https://almumayaz.online/support/my-tickets" style="display:inline-block;padding:13px 34px;' +
        'background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:bold;">متابعة التذكرة</a></div>' +
        '<p style="font-size:12px;color:#999;text-align:center;margin:0;">هذه الرسالة مرسلة بشكل آلي، يرجى عدم الرد.</p></div></div>';
      await emailService.sendMail(ticket.requesterEmail, subjLine, emailHtml);
    } catch(e) { console.error('[Support] Email notify failed:', e.message); }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: 'حدث خطأ' }); }
});

// POST /support/admin/ticket/:id/close
app.post('/support/admin/ticket/:id/close', requireSupport, async (req, res) => {
  try {
    var tickets = await readData('supportTickets') || [];
    var idx = tickets.findIndex(function(t){return t.id===req.params.id;});
    if (idx===-1) return res.json({ success: false, error: 'التذكرة غير موجودة' });
    tickets[idx].status = 'closed';
    await writeData('supportTickets', tickets);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: 'حدث خطأ' }); }
});

// POST /support/admin/ticket/:id/delete — permanently delete ticket
app.post('/support/admin/ticket/:id/delete', requireSupport, async (req, res) => {
  try {
    var tickets = await readData('supportTickets') || [];
    var idx = tickets.findIndex(function(t){return t.id===req.params.id;});
    if (idx===-1) return res.json({ success: false, error: 'التذكرة غير موجودة' });
    var ticketId = tickets[idx].id;
    tickets.splice(idx, 1);
    await writeData('supportTickets', tickets);
    try { await getPrisma().ticketReply.deleteMany({ where: { ticketId } }); } catch(e) {}
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: 'حدث خطأ' }); }
});

// GET /support/logout
app.get('/support/logout', function(req, res) {
  req.session.supportAccess = false;
  res.redirect('/support');
});

// POST /support/ticket/:id/reply — student reply to their ticket
app.post('/support/ticket/:id/reply', async (req, res) => {
  try {
    var { text, email } = req.body;
    if (!text) return res.json({ success: false, error: 'الرد مطلوب' });
    // Logged-in user: use session email; guest: require email in body
    if (req.session.user && req.session.user.email) {
      email = req.session.user.email;
    }
    if (!email) return res.json({ success: false, error: 'البريد الإلكتروني مطلوب' });
    var tickets = await readData('supportTickets') || [];
    var idx = tickets.findIndex(function(t){return t.id===req.params.id;});
    if (idx===-1) return res.json({ success: false, error: 'التذكرة غير موجودة' });
    if (tickets[idx].status !== 'open') return res.json({ success: false, error: 'التذكرة مغلقة ولا يمكن الرد' });
    if (tickets[idx].requesterEmail.toLowerCase() !== email.toLowerCase()) return res.json({ success: false, error: 'البريد الإلكتروني غير مطابق' });
    var prisma = getPrisma();
    await prisma.ticketReply.create({
      data: {
        ticketId: tickets[idx].id,
        senderRole: 'student',
        senderName: tickets[idx].requesterName,
        message: text,
        createdAt: new Date()
      }
    });
    await writeData('supportTickets', tickets);
    // notify admins by email + push
    try {
      var prisma = getPrisma();
      var admins = await prisma.user.findMany({ where: { role: 'admin', deletedAt: null } });
      for (var ai=0; ai<admins.length; ai++) {
        var au = admins[ai];
        if (au.email) {
          try {
            var html = '<div style="font-family:Tahoma,Arial,sans-serif;max-width:560px;margin:0 auto;">' +
              '<div style="background:linear-gradient(135deg,#0f1b34,#1a2d50);padding:28px;text-align:center;border-radius:16px 16px 0 0;">' +
              '<div style="color:#F59E0B;font-size:26px;font-weight:bold;">منصة المُميز</div>' +
              '<div style="color:#FBBF24;font-size:13px;margin-top:4px;">Almumayaz Educational Platform</div>' +
              '<div style="width:40px;height:3px;background:linear-gradient(90deg,#F59E0B,#FBBF24);border-radius:2px;margin:12px auto;"></div>' +
              '<div style="color:#fde68a;font-size:16px;margin-top:8px;font-weight:600;">رد جديد على تذكرة دعم</div></div>' +
              '<div style="padding:28px;background:#fff;border-radius:0 0 16px 16px;color:#374151;">' +
              '<p style="margin:0 0 16px;"><strong>' + escHtml(tickets[idx].requesterName) + '</strong> أرسل رداً على تذكرته:</p>' +
              '<div style="padding:16px;background:#f8f8f8;border-right:3px solid #f59e0b;border-radius:8px;margin:0 0 20px;">' +
              '<p style="margin:0;color:#333;line-height:1.9;font-size:14px;">' + escHtml(text).replace(/\n/g,'<br>') + '</p></div>' +
              '<div style="text-align:center;"><a href="https://almumayaz.online/support/admin/ticket/' + tickets[idx].id + '" ' +
              'style="display:inline-block;padding:13px 34px;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;' +
              'text-decoration:none;border-radius:8px;font-size:15px;font-weight:bold;">عرض الرد</a></div></div></div>';
            await emailService.sendMail(au.email, '💬 رد من ' + tickets[idx].requesterName + ' على تذكرة الدعم', html);
          } catch(e) { console.error('[support] notify admin reply error:', e.message); }
        }
        if (au.fcmToken) {
          try {
            await admin.messaging().send({
              token: au.fcmToken,
              notification: { title: 'رد من ' + tickets[idx].requesterName + ' 💬', body: 'على تذكرة: ' + tickets[idx].subject },
              data: { url: '/support/admin/ticket/' + tickets[idx].id }
            });
          } catch(e) {}
        }
      }
    } catch(e) {}
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: 'حدث خطأ' }); }
});

// GET /support/my-tickets — public ticket lookup by email
app.get('/support/my-tickets', async function(req, res) {
  // Logged-in user: auto-use session email; guest: require query param
  var email = '';
  if (req.session.user && req.session.user.email) {
    email = req.session.user.email.trim().toLowerCase();
  } else {
    email = req.query.email ? req.query.email.trim().toLowerCase() : '';
  }
  var isLoggedIn = !!(req.session.user && req.session.user.email);
  var tickets = [];
  if (email) {
    try {
      var all = await readData('supportTickets') || [];
      tickets = all.filter(function(t){return t.requesterEmail && t.requesterEmail.toLowerCase()===email;});
      tickets.sort(function(a,b){return new Date(b.createdAt)-new Date(a.createdAt);});
    } catch(e) {}
  }
  // Fetch replies from Prisma for all matching tickets
  var repliesByTicket = {};
  if (tickets.length) {
    try {
      var prisma = getPrisma();
      var allReplies = await prisma.ticketReply.findMany({
        where: { ticketId: { in: tickets.map(function(t){return t.id;}) } },
        orderBy: { createdAt: 'asc' }
      });
      allReplies.forEach(function(r) {
        if (!repliesByTicket[r.ticketId]) repliesByTicket[r.ticketId] = [];
        repliesByTicket[r.ticketId].push(r);
      });
    } catch(e) {}
  }
  res.send(
    '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
    '<script>document.documentElement.setAttribute("data-theme",localStorage.getItem("lughati-theme")||(window.matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light"))</script>' +
    '<title>تذاكري — الدعم الفني | المُميز</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&family=Aref+Ruqaa:wght@400;700&display=swap" rel="stylesheet">' +
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">' +
    '<style>' +
    ':root,[data-theme="dark"]{--bg:#0f172a;--card-bg:rgba(255,255,255,.03);--card-border:rgba(255,255,255,.06);--text:#e2e8f0;--text-light:#94a3b8;--text-muted:#64748b;--input-bg:rgba(255,255,255,.04);--input-border:rgba(255,255,255,.08);--border:rgba(255,255,255,.06);}' +
    '[data-theme="light"]{--bg:#f4f4f6;--card-bg:#fff;--card-border:#e0e0e0;--text:#111;--text-light:#555;--text-muted:#888;--input-bg:#f8f8f8;--input-border:#ddd;--border:#e0e0e0;}' +
    '*{box-sizing:border-box;margin:0;padding:0;scrollbar-width:none;-ms-overflow-style:none}*::-webkit-scrollbar{display:none}' +
    'body{font-family:Cairo,Tahoma,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--bg);color:var(--text);padding:20px;}' +
    'body::before{content:"";position:fixed;inset:0;' +
    'background:radial-gradient(ellipse at 50% 0%,rgba(245,158,11,.04) 0%,transparent 60%),' +
    'radial-gradient(ellipse at 80% 100%,rgba(59,130,246,.02) 0%,transparent 50%);' +
    'pointer-events:none;}' +
    '.wrap{max-width:700px;margin:0 auto;position:relative;z-index:1;width:100%;}' +
    '.logo{text-align:center;padding:24px 0;text-decoration:none;display:block;}' +
    '.logo .ar{font-family:\'Aref Ruqaa\',serif;font-size:32px;background:linear-gradient(135deg,#FBBF24,#D97706);' +
    '-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}' +
    '.card{background:var(--card-bg);border:1px solid var(--card-border);border-radius:20px;padding:28px 24px;margin-bottom:20px;}' +
    '.card h2{font-size:20px;font-weight:700;margin-bottom:4px;}' +
    '.card p{font-size:13px;color:var(--text-light);margin-bottom:20px;}' +
    '.search-box{display:flex;gap:8px;}' +
    '.search-box input{flex:1;padding:12px 16px;border-radius:12px;border:1px solid var(--input-border);' +
    'background:var(--input-bg);color:var(--text);font-size:14px;font-family:Cairo,Tahoma,sans-serif;outline:none;direction:ltr;text-align:left;}' +
    '.search-box input:focus{border-color:#F59E0B;}' +
    '.search-box button{padding:12px 24px;border-radius:12px;border:none;background:linear-gradient(135deg,#F59E0B,#D97706);' +
    'color:#fff;font-size:14px;font-weight:700;font-family:Cairo,Tahoma,sans-serif;cursor:pointer;transition:all .3s;white-space:nowrap;}' +
    '.search-box button:hover{transform:translateY(-2px);}' +
    '.ticket{background:var(--card-bg);border:1px solid var(--card-border);border-radius:16px;padding:20px 24px;margin-bottom:16px;transition:all .3s;box-shadow:0 2px 12px rgba(0,0,0,.04);}' +
    '.ticket:hover{box-shadow:0 8px 30px rgba(0,0,0,.08);border-color:rgba(245,158,11,.2);}' +
    '.ticket .top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;}' +
    '.ticket .subj{font-size:16px;font-weight:700;}' +
    '.ticket .badge{font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600;}' +
    '.ticket .badge.open{background:rgba(34,197,94,.1);color:#4ade80;border:1px solid rgba(34,197,94,.2);}' +
    '.ticket .badge.closed{background:rgba(100,116,139,.1);color:var(--text-muted);border:1px solid rgba(100,116,139,.2);}' +
    '.ticket .meta{font-size:12px;color:var(--text-muted);margin-top:8px;}' +
    '.ticket .meta i{margin-left:4px;width:14px;}' +
    '.reply-thread{margin-top:12px;padding-top:12px;border-top:1px solid var(--border);}' +
    '.thread-item{padding:10px 14px;margin-bottom:8px;border-radius:10px;font-size:13px;line-height:1.7;}' +
    '.thread-item.admin{background:rgba(245,158,11,.06);border-right:3px solid #F59E0B;}' +
    '.thread-item.user{background:var(--input-bg);border-right:3px solid var(--text-muted);}' +
    '.thread-item .th-hdr{display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:4px;}' +
    '.thread-item .th-name{font-weight:700;}' +
    '.thread-item.admin .th-name{color:#F59E0B;}' +
    '.reply-form{margin-top:12px;}' +
    '.reply-form textarea{width:100%;padding:10px 14px;border-radius:10px;border:1px solid var(--input-border);' +
    'background:var(--input-bg);color:var(--text);font-size:13px;font-family:Cairo,Tahoma,sans-serif;' +
    'outline:none;resize:vertical;min-height:50px;transition:border-color .2s;}' +
    '.reply-form textarea:focus{border-color:#F59E0B;}' +
    '.reply-form .r-actions{display:flex;gap:8px;margin-top:8px;}' +
    '.reply-form .r-actions button{padding:8px 16px;border-radius:8px;border:none;font-size:12px;font-weight:700;' +
    'font-family:Cairo,Tahoma,sans-serif;cursor:pointer;transition:all .3s;display:flex;align-items:center;gap:4px;}' +
    '.reply-form .r-actions .r-send{background:linear-gradient(135deg,#F59E0B,#D97706);color:#fff;}' +
    '.reply-form .r-actions .r-send:hover{transform:translateY(-1px);}' +
    '.reply-form .r-actions .r-cancel{background:var(--input-bg);color:var(--text-light);}' +
    '.reply-form .r-actions .r-cancel:hover{background:rgba(255,255,255,.08);}[data-theme="light"] .reply-form .r-actions .r-cancel:hover{background:rgba(0,0,0,.04);}' +
    '.reply-toggle{display:inline-block;margin-top:8px;padding:5px 12px;border-radius:6px;border:none;' +
    'background:rgba(245,158,11,.1);color:#F59E0B;font-size:11px;font-weight:600;font-family:Cairo,Tahoma,sans-serif;cursor:pointer;transition:all .2s;}' +
    '.reply-toggle:hover{background:rgba(245,158,11,.2);}' +
    '.empty{text-align:center;padding:40px 20px;color:var(--text-muted);}' +
    '.empty i{font-size:40px;margin-bottom:12px;opacity:.3;}' +
    '.back{display:inline-block;margin-bottom:16px;color:var(--text-muted);text-decoration:none;font-size:13px;}' +
    '.back:hover{color:#F59E0B;}' +
    '</style></head><body>' +
    '<div class="wrap">' +
    '<a href="/" class="logo"><span class="ar">المُميز</span></a>' +
    '<div class="card">' +
    '<h2>تذاكري</h2>' +
    (isLoggedIn ?
    '<p>عرض جميع تذاكر الدعم الخاصة بك مع الردود</p>' :
    '<p>أدخل بريدك الإلكتروني لعرض جميع تذاكر الدعم الخاصة بك مع الردود</p>' +
    '<form class="search-box" method="GET" action="/support/my-tickets">' +
    '<input type="email" name="email" required placeholder="بريدك الإلكتروني" value="' + (email ? escHtml(email) : '') + '">' +
    '<button type="submit"><i class="fas fa-search"></i> بحث</button>' +
    '</form>') +
    '</div>' +
    (email && tickets.length === 0 ?
    '<div class="card" style="text-align:center;color:#64748b;"><i class="fas fa-inbox" style="font-size:36px;opacity:.3;display:block;margin-bottom:12px;"></i>لا توجد تذاكر لهذا البريد</div>' : '') +
    (tickets.length ? tickets.map(function(t) {
      var d = new Date(t.createdAt);
      var ds = d.toLocaleDateString("ar-EG",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
      var tReplies = repliesByTicket[t.id] || [];
      // Fallback to legacy embedded replies
      if (!tReplies.length && t.replies && t.replies.length) tReplies = t.replies;
      var repliesHtml = '';
      if (tReplies.length) {
        repliesHtml += '<div class="reply-thread">' + tReplies.map(function(r) {
          var rd = new Date(r.createdAt);
          var rds = rd.toLocaleDateString("ar-EG",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
          var isAdmin = r.senderRole ? r.senderRole === 'admin' : r.isAdmin;
          var text = r.message || r.text || '';
          return '<div class="thread-item ' + (isAdmin?'admin':'user') + '">' +
            '<div class="th-hdr"><span class="th-name">' + (isAdmin?'الدعم الفني':escHtml(t.requesterName)) + '</span>' +
            '<span>' + rds + '</span></div>' +
            '<div>' + escHtml(text) + '</div></div>';
        }).join('') + '</div>';
      }
      return '<div class="ticket" id="ticket-' + t.id + '">' +
        '<div class="top"><span class="subj">' + escHtml(t.subject) + '</span>' +
        '<span class="badge ' + t.status + '">' + (t.status==='open'?'مفتوحة':'مغلقة') + '</span></div>' +
        '<div class="meta"><span><i class="fas fa-clock"></i>' + ds + '</span>' +
        (tReplies.length ? '<span style="margin-right:12px;"><i class="fas fa-reply"></i>' + tReplies.length + ' ردود</span>' : '') +
        '</div>' + repliesHtml +
        (t.status === 'open' ?
        '<div style="margin-top:8px;"><button class="reply-toggle" onclick="toggleR(\'' + t.id + '\')"><i class="fas fa-reply"></i> رد</button></div>' +
        '<div id="rf-' + t.id + '" class="reply-form" style="display:none;">' +
        '<textarea id="rt-' + t.id + '" placeholder="اكتب ردك..."></textarea>' +
        '<div class="r-actions">' +
        '<button class="r-send" onclick="sendReply(\'' + t.id + '\',\'' + escHtml(email) + '\')"><i class="fas fa-paper-plane"></i> إرسال</button>' +
        '<button class="r-cancel" onclick="toggleR(\'' + t.id + '\')">إلغاء</button></div></div>'
        : '') +
        '</div>';
    }).join('') : '') +
    '<div style="text-align:center;margin-top:12px;"><a href="/support" class="back"><i class="fas fa-arrow-right"></i> العودة للدعم الفني</a></div>' +
    '</div>' +
    '<script>' +
    'function toggleR(id){var f=document.getElementById("rf-"+id);if(f.style.display==="none"){f.style.display="block";}else{f.style.display="none";}}' +
    'function sendReply(id,email){var ta=document.getElementById("rt-"+id);if(!ta||!ta.value.trim())return;var text=ta.value.trim();' +
    'var btn=ta.parentElement.querySelector(".r-send");btn.disabled=true;btn.innerHTML=\'<i class="fas fa-spinner fa-spin"></i>\';' +
    'var payload={text:text};if(email)payload.email=email;' +
    'fetch("/support/ticket/"+id+"/reply",{method:"POST",headers:{"Content-Type":"application/json"},' +
    'body:JSON.stringify(payload)}).then(function(r){return r.json()}).then(function(d){' +
    'if(d.success){window.location.reload();}else{btn.disabled=false;btn.innerHTML=\'<i class="fas fa-paper-plane"></i> إرسال\';alert(d.error||"حدث خطأ");}' +
    '}).catch(function(){btn.disabled=false;btn.innerHTML=\'<i class="fas fa-paper-plane"></i> إرسال\';alert("حدث خطأ في الاتصال");});}' +
    '</script>' +
    '</body></html>'
  );
});

/* ===================== GUEST MIDDLEWARE ===================== */

function requireStudentOrGuest(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role === 'student' || req.session.user.role === 'admin' || req.session.demoMode) return next();
  res.redirect('/login');
}

function requireStudent(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role === 'student' || req.session.user.role === 'admin') return next();
  return res.redirect('/student/courses');
}

/* ===================== STUDENT ROUTES ===================== */

app.get('/student', requireStudentOrGuest, async (req, res) => {
  var courses = await readData('courses');
  const user = req.session.user;
  const isGuest = req.session.demoMode;
  var userStage = (user && user.stage) || '';
  var userGrade = (user && user.grade) || '';
  var subscriptionStage = (user && user.subscribedStage) || '';
  var allowedStages = [];
  if (userStage) allowedStages.push(userStage);
  if (subscriptionStage && allowedStages.indexOf(subscriptionStage) === -1) allowedStages.push(subscriptionStage);
  if (allowedStages.length) courses = courses.filter(function(c) { return allowedStages.indexOf(c.stage) !== -1 || c.stage === 'all'; });
  if (userGrade) courses = courses.filter(function(c) { return c.grade === userGrade || !c.grade; });
  var currentSemester = res.locals.currentSemester || 'all';
  if (currentSemester !== 'all') courses = courses.filter(function(c) { return c.semester === currentSemester || c.semester === 'all'; });
  const announcements = await readData('announcements');
  let progress = {};
  let analyticsData = null;
  if (!isGuest && req.session.user) {
    const prisma = getPrisma();
    const u = await prisma.user.findUnique({ where: { id: req.session.user.id }, select: { progress: true } });
    progress = (u && u.progress) || {};
    try { analyticsData = await analytics.getStudentDashboardData(req.session.user.uid); } catch(e) {}
  }
  res.render('student/dashboard', { courses, announcements, progress, isGuest, analyticsData, title: 'لوحة التحكم - المُميز' });
});

function normGrade(g) {
  if (!g) return '';
  var s = g.trim().replace(/[أإآ]/g, 'ا').replace(/[\s\-_]+/g, '');
  var map = {
    '3ث':'3','3ثانوي':'3','تالتةثانوي':'3','تالتثانوي':'3','الثالثالثانوي':'3',
    '2ث':'2','2ثانوي':'2','تانيةثانوي':'2','تانيثانوي':'2','الثانيالثانوي':'2',
    '1ث':'1','1ثانوي':'1','اولىثانوي':'1','اوليثانوي':'1','الأولالثانوي':'1',
    'السادسابتدائي':'6اب','6ابتدائي':'6اب',
    'الخامسابتدائي':'5اب','5ابتدائي':'5اب',
    'الرابعابتدائي':'4اب','4ابتدائي':'4اب',
    'الثالثابتدائي':'3اب','3ابتدائي':'3اب',
    'الثانيابتدائي':'2اب','2ابتدائي':'2اب',
    'الأولابتدائي':'1اب','1ابتدائي':'1اب',
    'الثالثالاعدادي':'3اعد','3اعدادي':'3اعد',
    'الثانيالاعدادي':'2اعد','2اعدادي':'2اعد',
    'الأولالاعدادي':'1اعد','1اعدادي':'1اعد',
  };
  for (var k in map) { if (s.indexOf(k.replace(/[أإآ]/g,'ا').replace(/[\s\-_]/g,'')) !== -1) return map[k]; }
  return s;
}
function normStage(g) {
  if (!g) return '';
  var s = g.trim().replace(/[أإآ]/g, 'ا').replace(/[\s\-_]+/g, '').replace(/ة$/, '');
  if (s.indexOf('ثان') !== -1) return 'ثانوي';
  if (s.indexOf('اعد') !== -1) return 'اعدادي';
  if (s.indexOf('ابت') !== -1) return 'ابتدائي';
  return s;
}

app.get('/student/live-sessions', requireStudentOrGuest, async (req, res) => {
  try {
    var sessions = await readData('liveSessions') || [];
    var user = req.session.user;
    var userGrade = (user && user.grade) || '';
    var userStage = (user && user.stage) || '';
    var filtered = sessions.filter(function(s) {
      if (s.status === 'Cancelled') return false;
      if (userGrade && s.grade && normGrade(s.grade) !== normGrade(userGrade)) return false;
      if (userStage && s.stage && normStage(s.stage) !== normStage(userStage)) return false;
      return true;
    });
    filtered.sort(function(a, b) { return new Date(a.startTime) - new Date(b.startTime); });
    res.render('student/live-sessions', { sessions: filtered, title: 'الحصص المباشرة - المُميز', isGuest: req.session.demoMode });
  } catch(e) {
    res.render('student/live-sessions', { sessions: [], title: 'الحصص المباشرة - المُميز', isGuest: req.session.demoMode });
  }
});

app.get('/student/notifications', requireStudent, async (req, res) => {
  try {
    const all = await readData('notifications') || [];
    const u = req.session.user;
    const dismissed = await readData('dismissed/' + u.id) || {};
    const list = all.filter(function(n) {
      if (n.target === 'all') return true;
      if (n.target === 'student' && n.targetValue === u.id) return true;
      if (n.target === 'grade' && n.targetValue === u.grade) return true;
      if (n.target === 'stage' && n.targetValue === u.stage) return true;
      return false;
    }).filter(function(n) { return !dismissed[n.id]; }).sort(function(a, b) { return new Date(b.sentAt) - new Date(a.sentAt); });
    res.render('student/notifications', { notifications: list, title: 'مركز الإشعارات - المُميز' });
  } catch (e) {
    res.render('student/notifications', { notifications: [], title: 'مركز الإشعارات - المُميز' });
  }
});

app.get('/student/my-progress', requireStudent, async (req, res) => {
  try {
    res.render('student/my-progress', { title: 'تقدّمي - المُميز' });
  } catch(e) {
    res.status(500).send('خطأ في تحميل تقدّمي');
  }
});

app.post('/student/notifications/dismiss', requireStudent, async (req, res) => {
  try {
    const id = req.body && req.body.id;
    if (!id) return res.status(400).json({ ok: false });
    const u = req.session.user;
    const dismissed = await readData('dismissed/' + u.id) || {};
    dismissed[id] = true;
    await writeData('dismissed/' + u.id, dismissed);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.get('/student/courses', requireStudentOrGuest, async (req, res) => {
  var courses = await readData('courses');
  const user = req.session.user;
  var userStage = (user && user.stage) || '';
  var userGrade = (user && user.grade) || '';
  var subscriptionStage = (user && user.subscribedStage) || '';
  var allowedStages = [];
  if (userStage) allowedStages.push(userStage);
  if (subscriptionStage && allowedStages.indexOf(subscriptionStage) === -1) allowedStages.push(subscriptionStage);
  // Filter by student's stage and grade
  if (allowedStages.length) courses = courses.filter(function(c) { return allowedStages.indexOf(c.stage) !== -1 || c.stage === 'all'; });
  if (userGrade) courses = courses.filter(function(c) { return c.grade === userGrade || !c.grade; });
  // Teacher's setting (currentSemester) controls which term is visible to the student (no manual student selection)
  var currentSemester = res.locals.currentSemester || 'all';
  if (currentSemester !== 'all') courses = courses.filter(function(c) { return c.semester === currentSemester || c.semester === 'all'; });
  // Plan-based lesson filtering is done per-lesson on the lesson page
  res.render('student/courses', { courses: courses, userStage: userStage, userGrade: userGrade, currentSemester: currentSemester, title: 'المحاضرات - المُميز' });
});

app.get('/student/course/:id', requireStudentOrGuest, async (req, res) => {
  const courses = await readData('courses');
  const course = courses.find(c => c.id === req.params.id);
  if (!course) return res.redirect('/student/courses');

  // filter out unpublished lessons
  if (course.lessons) course.lessons = course.lessons.filter(function(l){ return l.published !== false; });

  const user = req.session.user;
  const isGuest = req.session.demoMode;
  const isSubscribed = !isGuest && user.subscriptionStatus === 'active' && (!user.subscriptionEnd || new Date(user.subscriptionEnd) > new Date());
  const currentSemester = res.locals.currentSemester || 'all';

  let lessonStatuses = null;
  if (!isGuest && user.uid) {
    try {
      const a = await analytics.getAnalyticsFresh(user.uid);
      // Read fresh progress from Prisma (not stale session)
      let freshProgress = {};
      try {
        const fu = await readUserById(user.uid);
        if (fu && fu.progress) freshProgress = fu.progress;
      } catch(e) {}
      const fromProgress = (freshProgress[course.id] && freshProgress[course.id].completedLessons) || [];
      const fromSession = req.session.quizDoneLessons || [];
      const userCompleted = [...new Set([...fromProgress, ...fromSession])];
      const computed = analytics.computeLessonStatuses(user.uid, course, a.lessonProgress || {}, a.courseProgress || {}, userCompleted);
      lessonStatuses = computed.lessonStatuses;
    } catch(e) {}
  }

  res.render('student/course-detail', {
    course, user, isGuest, isSubscribed, currentSemester, lessonStatuses,
    title: `${course.title} - المُميز`
  });
});

app.get('/student/lesson/:courseId/:lessonId', requireStudentOrGuest, async (req, res) => {
  const courses = await readData('courses');
  const course = courses.find(c => c.id === req.params.courseId);
  if (!course) return res.redirect('/student/courses');
  const lesson = (course.lessons||[]).find(l => l.id === req.params.lessonId);
  if (!lesson) return res.redirect(`/student/course/${course.id}`);
  if (lesson.published === false) return res.redirect(`/student/course/${course.id}`);

  const user = req.session.user;
  const isGuest = req.session.demoMode;
  const isSubscribed = !isGuest && user.subscriptionStatus === 'active' && (!user.subscriptionEnd || new Date(user.subscriptionEnd) > new Date());
  const isFree = lesson.isFree === true;

  // Read fresh user data for progress (not from stale session)
  let freshUserData = null;
  try {
    freshUserData = await readUserById(user.uid);
  } catch(e) {}
  const freshProgress = (freshUserData && freshUserData.progress) || {};

  let lessonStatuses = null;
  let lockReason = null;
  let hasVideo = !!(lesson.videos && lesson.videos.length) || !!lesson.videoUrl;

  if (!isGuest && user.uid) {
    try {
      const a = await analytics.getAnalyticsFresh(user.uid);
      const fromProgress = (freshProgress[course.id] && freshProgress[course.id].completedLessons) || [];
      const fromSession = req.session.quizDoneLessons || [];
      const userCompleted = [...new Set([...fromProgress, ...fromSession])];
      const computed = analytics.computeLessonStatuses(user.uid, course, a.lessonProgress || {}, a.courseProgress || {}, userCompleted);
      lessonStatuses = computed.lessonStatuses;
      const thisLesson = lessonStatuses.find(s => s.lessonId === lesson.id);
      if (thisLesson && !thisLesson.isUnlocked && !isFree) {
        lockReason = 'sequential';
      }
      if (!hasVideo && !(lesson.quiz && lesson.quiz.enabled) && lockReason !== 'sequential' && thisLesson && !thisLesson.isCompleted) {
        try {
          const prisma = getPrisma();
          const lpId = `${user.id}_${lesson.id}`;
          await prisma.lessonProgress.upsert({
            where: { id: lpId },
            create: { id: lpId, studentId: user.id, lessonId: lesson.id, completed: true, completedAt: new Date(), watchTime: 0, lastAccess: new Date() },
            update: { completed: true, completedAt: new Date() },
          });
        } catch(e2) {}
      }
    } catch(e) {}
  }

  // Check subscription lock (overrides sequential if also not subscribed)
  if (!isFree && !isSubscribed && !(isGuest && lesson.guestVisible)) {
    lockReason = 'subscription';
  // Check if the plan includes this specific lesson
  } else if (!isFree && isSubscribed && !isGuest && user.planName && !lockReason) {
    try {
      const plans = await readData('subscriptions') || [];
      const userPlan = plans.find(p => p.name === user.planName && p.period === user.planPeriod && (!p.stage || p.stage === user.subscribedStage));
      if (userPlan && userPlan.allowedLessons && Array.isArray(userPlan.allowedLessons) && userPlan.allowedLessons[0] !== '*') {
        if (userPlan.allowedLessons.indexOf(lesson.id) === -1) {
          lockReason = 'plan';
        }
      }
    } catch(e) { /* silently degrade to full access */ }
  }

  // Check if lesson quiz already attempted (one-time guard)
  let quizDone = false;
  if (lesson.quiz && lesson.quiz.enabled && !isGuest && user.uid) {
    const qSessionDone = user.progress && user.progress[course.id] &&
      user.progress[course.id].completedLessons &&
      user.progress[course.id].completedLessons.includes(lesson.id);
    let qFirebaseDone = false;
    let qExamDone = false;
    let qPrismaDone = false;
    try {
      const u2 = await readUserById(user.uid);
      if (u2) {
        if (u2.progress && u2.progress[course.id] && u2.progress[course.id].completedLessons) {
          qFirebaseDone = u2.progress[course.id].completedLessons.includes(lesson.id);
        }
        var qr = u2.quizResults && u2.quizResults[course.id] && u2.quizResults[course.id][lesson.id];
        qExamDone = qr && qr.passed === true;
      }
      const prisma = getPrisma();
      const passedAttempt = await prisma.examAttempt.findFirst({
        where: { userId: user.id, examId: lesson.id, status: 'passed' }
      });
      qPrismaDone = !!passedAttempt;
    } catch(e) {}
    quizDone = qSessionDone || qFirebaseDone || qExamDone || qPrismaDone || (req.session.quizDoneLessons && req.session.quizDoneLessons.includes(lesson.id));
  }

  res.render('student/lesson', {
    course, lesson, user, isGuest, isSubscribed, isFree, hasVideo, lessonStatuses, quizDone, lockReason,
    title: `${lesson.title} - المُميز`
  });
});

app.get('/student/lesson-quiz/:courseId/:lessonId', requireStudentOrGuest, async (req, res) => {
  const courses = await readData('courses');
  const course = courses.find(c => c.id === req.params.courseId);
  if (!course) return res.redirect('/student/courses');
  const lesson = (course.lessons||[]).find(l => l.id === req.params.lessonId);
  if (!lesson) return res.redirect(`/student/course/${course.id}`);
  if (lesson.published === false) return res.redirect(`/student/course/${course.id}`);
  if (!lesson.quiz || !lesson.quiz.enabled) return res.redirect(`/student/lesson/${course.id}/${lesson.id}`);

  const user = req.session.user;
  const isGuest = req.session.demoMode;
  const isSubscribed = !isGuest && user.subscriptionStatus === 'active' && (!user.subscriptionEnd || new Date(user.subscriptionEnd) > new Date());
  const isFree = lesson.isFree === true;
  if (!isFree && !isSubscribed && !(isGuest && lesson.guestVisible)) {
    return res.render('student/subscription-locked', { title: 'الاشتراك مطلوب - المُميز', isGuest });
  }

  // Load saved quiz result for review (passed quiz = show answers, failed = retry)
  let quizResult = null;
  try {
    const prisma = getPrisma();
    const bestAttempt = await prisma.examAttempt.findFirst({
      where: { userId: user.id, examId: lesson.id, status: 'passed' },
      orderBy: { endTime: 'desc' }
    });
    if (bestAttempt) {
      const nScore = Number(bestAttempt.score) || 0;
      const nTotal = Number(bestAttempt.total) || 1;
      quizResult = {
        score: nScore,
        total: nTotal,
        percentage: Math.round(nScore / nTotal * 100),
        passed: bestAttempt.status === 'passed',
        answers: Array.isArray(bestAttempt.answers) ? bestAttempt.answers : {},
        completedAt: bestAttempt.endTime ? bestAttempt.endTime.getTime() : null,
      };
    }
  } catch(e) {}
  const quizPassed = quizResult && quizResult.passed === true;
  const quizFailed = quizResult && quizResult.passed === false;

  // Find next lesson using computeLessonStatuses (respects order + unlock chain)
  let nextLesson = null;
  if (!isGuest && user.uid) {
    try {
      var prisma = getPrisma();
      var dbUser = await prisma.user.findUnique({ where: { id: user.id }, select: { progress: true } });
      var freshProgress = (dbUser && dbUser.progress) || {};
      const a = await analytics.getAnalyticsFresh(user.uid);
      const fromProgress = (freshProgress[course.id] && freshProgress[course.id].completedLessons) || [];
      const fromSession = req.session.quizDoneLessons || [];
      const userCompleted = [...new Set([...fromProgress, ...fromSession])];
      const computed = analytics.computeLessonStatuses(user.uid, course, a.lessonProgress || {}, a.courseProgress || {}, userCompleted);
      const sorted = (course.lessons || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      // Find current position in lesson sequence
      const curIdx = sorted.findIndex(l => l.id === lesson.id);
      // If this lesson is the current one (first unlocked + not completed), next is after it
      if (computed.currentLesson && computed.currentLesson.lessonId === lesson.id && curIdx >= 0 && curIdx < sorted.length - 1) {
        nextLesson = sorted[curIdx + 1];
      }
      // If this lesson was already completed, the currentLesson is the actual next one to work on
      if (!nextLesson && computed.currentLesson && computed.currentLesson.lessonId !== lesson.id) {
        const nextIdx = sorted.findIndex(l => l.id === computed.currentLesson.lessonId);
        if (nextIdx >= 0) nextLesson = sorted[nextIdx];
      }
    } catch(e) {}
  }

  res.render('student/lesson-quiz', {
    course, lesson, nextLesson, isGuest, quizPassed, quizFailed, quizResult,
    quizDone: quizResult != null,
    title: `اختبار ${lesson.title} - المُميز`
  });
});

// Render the PDF.js viewer for a stored entry. The page itself contains NO direct
// file link - it is given a same-origin `tokenUrl`; its JS fetches a short-lived
// Supabase signed URL (after the server re-checks permissions) and feeds it to PDF.js.
app.get('/student/view-pdf/:courseId/:lessonId/:pdfIdx', requireStudentOrGuest, async (req, res) => {
  const courses = await readData('courses');
  const course = courses.find(c => c.id === req.params.courseId);
  if (!course) return res.redirect('/student/courses');
  const lesson = (course.lessons||[]).find(l => l.id === req.params.lessonId);
  if (!lesson) return res.redirect(`/student/course/${course.id}`);
  const idx = parseInt(req.params.pdfIdx);
  const entry = lesson.pdfFiles && lesson.pdfFiles[idx];
  if (!entry || !entry.path) return res.redirect(`/student/lesson/${course.id}/${lesson.id}`);
  if (!canAccessContent(req.session.user, lesson, req.session.demoMode)) return res.redirect('/student/subscription-locked');

  res.render('student/pdfjs-view', {
    tokenUrl: `/api/student/pdf-token/lesson/${course.id}/${lesson.id}/${idx}`,
    pdfTitle: entry.title || ('الملف ' + (idx + 1)),
    backUrl: `/student/lesson/${course.id}/${lesson.id}`,
    isGuest: !!req.session.demoMode,
    title: `${entry.title || 'ملف'} - المُميز`
  });
});

// Reviews: a review has pdfFiles[] like lessons.
app.get('/student/review-pdf/:reviewId/:pdfIdx', requireStudent, async (req, res) => {
  const reviews = (await readData('reviews')) || [];
  const review = reviews.find(r => r.id === req.params.reviewId);
  if (!review) return res.redirect('/student/reviews');
  // check access code for code-protected reviews
  if (review.accessCode && (!req.session.reviewAccess || !req.session.reviewAccess[review.id])) return res.redirect('/student/review/' + review.id);
  const idx = parseInt(req.params.pdfIdx);
  const entry = review.pdfFiles && review.pdfFiles[idx];
  if (!entry || !entry.path) return res.redirect(`/student/review/${review.id}`);
  if (!canAccessContent(req.session.user, review, req.session.demoMode)) return res.redirect('/student/subscription-locked');

  res.render('student/pdfjs-view', {
    tokenUrl: `/api/student/pdf-token/review/${review.id}/${idx}`,
    pdfTitle: entry.title || ('الملف ' + (idx + 1)),
    backUrl: `/student/review/${review.id}`,
    isGuest: !!req.session.demoMode,
    title: `${entry.title || 'ملف'} - المُميز`
  });
});

// Notes: single PDF per note (stored in the private bucket).
// Notes are subscriber-only content (locked for non-subscribers).
app.get('/student/note-pdf/:noteId', requireStudent, async (req, res) => {
  const user = req.session.user;
  const isSubscribed = user && user.subscriptionStatus === 'active' && (!user.subscriptionEnd || new Date(user.subscriptionEnd) > new Date());
  if (!isSubscribed) {
    return res.render('student/subscription-locked', { title: 'الاشتراك مطلوب - المُميز', isGuest: false });
  }

  const notes = await readData('notes');
  const note = notes.find(n => n.id === req.params.noteId);
  if (!note || !note.filePath) return res.redirect('/student/notes');

  res.render('student/pdfjs-view', {
    tokenUrl: `/api/student/pdf-token/note/${note.id}`,
    pdfTitle: note.title || 'مذكرة',
    backUrl: `/student/notes`,
    isGuest: false,
    title: `${note.title || 'مذكرة'} - المُميز`
  });
});

/* ===================== STUDENT: same-origin PDF stream =====================
   The browser fetches a SAME-ORIGIN URL, so there is no cross-origin CORS
   problem. Server-side we still mint a short-lived (60s) signed URL for the
   private Supabase object and pipe the bytes back. The signed URL never
   reaches the browser, and every request re-checks login/subscription. */
// Shared access check: mirrors the lesson-page gate (no UI-only enforcement).
function canAccessContent(user, item, demoMode) {
  const isGuest = !!demoMode;
  const isSubscribed = !isGuest && user && user.subscriptionStatus === 'active' && (!user.subscriptionEnd || new Date(user.subscriptionEnd) > new Date());
  const isFree = item && item.isFree === true;
  return !!(isFree || isSubscribed || (isGuest && item && item.guestVisible === true));
}
// Resolve the stored object path + item for a PDF, enforcing auth/subscription
// and the same paywall as the lesson page. Returns { path, item } or throws an
// Error carrying .status so callers can respond appropriately. `req` is captured
// from the enclosing route handler scope (canAccessContent relies on it too).
async function getPdfTarget(kind, req) {
  const u = req.session.user;
  let path = null, item = null;
  if (kind === 'lesson') {
    const courses = await readData('courses');
    const course = courses.find(c => String(c.id) === String(req.params.c));
    const lesson = course && (course.lessons || []).find(l => String(l.id) === String(req.params.l));
    item = lesson;
    const e = lesson && lesson.pdfFiles && lesson.pdfFiles[parseInt(req.params.i, 10)];
    path = e && e.path;
  } else if (kind === 'review') {
    const reviews = (await readData('reviews')) || [];
    const review = reviews.find(r => String(r.id) === String(req.params.id));
    item = review;
    const e = review && review.pdfFiles && review.pdfFiles[parseInt(req.params.i, 10)];
    path = e && e.path;
  } else if (kind === 'note') {
    const notes = await readData('notes');
    const note = notes.find(n => String(n.id) === String(req.params.id));
    item = note;
    path = note && note.filePath;
  }
  if ((kind === 'lesson' || kind === 'review') && !canAccessContent(u, item, req.session.demoMode)) {
    const err = new Error('Forbidden'); err.status = 403; throw err;
  }
  if (!path) { const err = new Error('Not found'); err.status = 404; throw err; }
  return { path, item };
}

// Mint a short-lived SAME-ORIGIN stream URL. The browser never touches Supabase
// directly (no CORS / CSP / range pitfalls) - the server streams the bytes back.
function makePdfToken(kind, authMiddleware, requireSubscription) {
  return [authMiddleware, async (req, res) => {
    try {
      const u = req.session.user;
      if (requireSubscription) {
        const sub = u && u.subscriptionStatus === 'active' && (!u.subscriptionEnd || new Date(u.subscriptionEnd) > new Date());
        if (!sub) return res.status(403).json({ error: 'Forbidden: active subscription required' });
      }
      if ((kind === 'note' || kind === 'lesson' || kind === 'review') && storageConfig.isR2Enabled()) {
        /* ok — R2 handles note/lesson/review file storage */
      } else if (!supabaseStorage.isConfigured()) {
        return res.status(503).json({ error: 'Storage not configured' });
      }
      const { path } = await getPdfTarget(kind, req);
      const streamUrl = '/api/student/pdf-stream/' + kind + '/' +
        (kind === 'note'
          ? req.params.id
          : (kind === 'lesson' ? (req.params.c + '/' + req.params.l + '/' + req.params.i)
                               : (req.params.id + '/' + req.params.i)));
      return res.json({ url: streamUrl });
    } catch (e) {
      const status = (e && e.status) || 401;
      console.error('[pdf-token] error:', { kind, message: e && e.message, status });
      return res.status(status).json({ error: safeErr(e, 'Unauthorized') });
    }
  }];
}

// Same-origin PDF byte stream: the server fetches the private Supabase object and
// pipes it back, so PDF.js loads a first-party URL (no cross-origin issues).
function makePdfStream(kind, authMiddleware, requireSubscription) {
  const { Readable } = require('stream');
  return [authMiddleware, async (req, res) => {
    try {
      const u = req.session.user;
      if (requireSubscription) {
        const sub = u && u.subscriptionStatus === 'active' && (!u.subscriptionEnd || new Date(u.subscriptionEnd) > new Date());
        if (!sub) return res.status(403).end('Forbidden: active subscription required');
      }
      if ((kind === 'note' || kind === 'lesson' || kind === 'review') && storageConfig.isR2Enabled()) {
        /* ok — R2 handles note/lesson/review file storage */
      } else if (!supabaseStorage.isConfigured()) {
        return res.status(503).end('Storage not configured');
      }
      const { path } = await getPdfTarget(kind, req);
      const signed = (kind === 'note' || kind === 'lesson' || kind === 'review') && storageConfig.isR2Enabled()
        ? await getStorageService().createSignedUrl(path, 300)
        : await supabaseStorage.createSignedUrl(path, 60);
      // Stage 11: forward any client Range header to the upstream so the browser can
      // seek/stream large PDFs without downloading the whole file through the server.
      const headers = {};
      const range = req.headers.range;
      if (range) headers['Range'] = range;
      const upstream = await fetch(signed, { headers });
      if (!upstream.ok && upstream.status !== 206 && upstream.status !== 416) {
        return res.status(502).end('Upstream storage error');
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      if (upstream.status === 206) {
        // Partial content: copy the upstream range headers straight through.
        res.status(206);
        const cr = upstream.headers.get('content-range');
        const cl = upstream.headers.get('content-length');
        if (cr) res.setHeader('Content-Range', cr);
        if (cl) res.setHeader('Content-Length', cl);
      } else {
        const cl = upstream.headers.get('content-length');
        if (cl) res.setHeader('Content-Length', cl);
      }
      if (upstream.body && typeof upstream.body.pipe === 'function') {
        upstream.body.pipe(res);
      } else if (upstream.body && typeof upstream.body.getReader === 'function') {
        Readable.fromWeb(upstream.body).pipe(res);
      } else {
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.end(buf);
      }
    } catch (e) {
      const status = (e && e.status) || 500;
      if (!res.headersSent) res.status(status).end('Stream error');
      else res.end();
    }
  }];
}

app.get('/api/student/pdf-token/lesson/:c/:l/:i', ...makePdfToken('lesson', requireStudentOrGuest));
app.get('/api/student/pdf-token/review/:id/:i', ...makePdfToken('review', requireStudent));
app.get('/api/student/pdf-token/note/:id', ...makePdfToken('note', requireStudent, true));
app.get('/api/student/pdf-stream/lesson/:c/:l/:i', ...makePdfStream('lesson', requireStudentOrGuest, false));
app.get('/api/student/pdf-stream/review/:id/:i', ...makePdfStream('review', requireStudent, false));
app.get('/api/student/pdf-stream/note/:id', ...makePdfStream('note', requireStudent, true));

// Student download note PDF (write to /tmp, then res.download)
app.get('/student/note-download/:noteId', requireStudent, async (req, res) => {
  try {
    const user = req.session.user;
    const sub = user && user.subscriptionStatus === 'active' && (!user.subscriptionEnd || new Date(user.subscriptionEnd) > new Date());
    if (!sub) return res.status(403).render('student/subscription-locked', { title: 'الاشتراك مطلوب - المُميز', isGuest: false });

    const notes = await readData('notes');
    const note = notes.find(n => String(n.id) === String(req.params.noteId));
    if (!note || !note.filePath) return res.redirect('/student/notes');

    const { path } = await getPdfTarget('note', req);
    const filename = path.split('/').pop() || (note.title || 'note') + '.pdf';
    const safeFilename = filename.replace(/"/g, '');

    const signed = storageConfig.isR2Enabled()
      ? await getStorageService().createSignedUrl(path, 300)
      : await supabaseStorage.createSignedUrl(path, 60);

    const upstream = await fetch(signed);
    if (!upstream.ok) {
      console.error('[note-download] storage fetch failed:', upstream.status, upstream.statusText);
      return res.status(502).end('Storage error');
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    const tmpFile = require('path').join(require('os').tmpdir(), 'dl-' + Date.now() + '-' + safeFilename);
    require('fs').writeFileSync(tmpFile, buf);
    console.log('[note-download] serving:', { filename: safeFilename, size: buf.length, tmpFile });
    res.download(tmpFile, safeFilename);
  } catch (e) {
    console.error('[note-download] error:', e && e.message, e && e.stack);
    if (!res.headersSent) res.redirect('/student/notes');
  }
});

/* ===================== ADMIN: upload PDF to private Supabase bucket ===================== */
/* Flow (avoids Vercel's ~4.5MB serverless body limit / HTTP 413):
    1) Browser asks for a short-lived signed UPLOAD url:  POST /api/admin/upload-pdf/sign  {folder,fileName}
    2) Browser uploads the file DIRECTLY to Supabase via that signed url (never hits Vercel body).
    3) Browser confirms:  POST /api/admin/upload-pdf  {path,fileName,fileSize}
       Server verifies the object now exists in the private bucket and returns the path. */
const _uuid = require('uuid');
function _buildPdfPath(folder, originalName) {
  let base = String(originalName || 'file')
    .replace(/\.[pP][dD][fF]$/, '')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if (!base) base = 'file';
  const f = (folder || 'misc').toString().replace(/[^a-z]/gi, '').toLowerCase() || 'misc';
  return f + '/' + _uuid.v4() + '-' + base + '.pdf';
}
app.post('/api/admin/upload-pdf/sign', requireAdmin, express.json(), async (req, res) => {
  try {
    const folder = (req.body.folder || 'misc').toString().replace(/[^a-z]/gi, '').toLowerCase() || 'misc';
    if (storageConfig.isR2Enabled()) {
      const storage = getStorageService();
      const objectKey = storage.generateObjectKey(folder, crypto.randomUUID(), 'file', req.body.fileName || 'file.pdf');
      const result = await storage.createSignedUploadUrl(objectKey, 'application/pdf');
      return res.json({ success: true, path: objectKey, signedUrl: result.signedUrl, token: null });
    }
    if (!supabaseStorage.isConfigured()) {
      return res.status(503).json({ error: 'نظام التخزين غير مهيأ. أضف متغيرات Supabase في إعدادات المشروع.' });
    }
    const path = _buildPdfPath(folder, req.body.fileName || 'file.pdf');
    const data = await supabaseStorage.createSignedUploadUrl(path);
    res.json({ success: true, path: path, signedUrl: data.signedUrl, token: data.token });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});
app.post('/api/admin/upload-pdf', requireAdmin, express.json(), async (req, res) => {
  try {
    const path = req.body.path;
    if (!path) return res.status(400).json({ error: 'لم يتم تحديد مسار الملف' });
    if (storageConfig.isR2Enabled()) {
      const storage = getStorageService();
      const exists = await storage.exists(path);
      if (!exists) return res.status(400).json({ error: 'الملف لم يُرفع بعد إلى التخزين. حاول مرة أخرى.' });
      return res.json({ success: true, path: path });
    }
    if (!supabaseStorage.isConfigured()) {
      return res.status(503).json({ error: 'نظام التخزين غير مهيأ. أضف متغيرات Supabase في إعدادات المشروع.' });
    }
    try {
      await supabaseStorage.createSignedUrl(path, 1);
    } catch (e) {
      return res.status(400).json({ error: 'الملف لم يُرفع بعد إلى التخزين. حاول مرة أخرى.' });
    }
    res.json({ success: true, path: path });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});
// Local-dev fallback: server receives the file directly (bypassed in prod by direct upload).
app.post('/api/admin/upload-pdf-legacy', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم إرفاق ملف' });
    const folder = (req.body.folder || 'misc').toString().replace(/[^a-z]/gi, '').toLowerCase() || 'misc';
    if (storageConfig.isR2Enabled()) {
      const storage = getStorageService();
      const objectKey = storage.generateObjectKey(folder, crypto.randomUUID(), 'file', req.file.originalname);
      await storage.upload({ key: objectKey, body: req.file.buffer, contentType: req.file.mimetype || 'application/octet-stream' });
      return res.json({ success: true, path: objectKey });
    }
    if (!supabaseStorage.isConfigured()) {
      return res.status(503).json({ error: 'نظام التخزين غير مهيأ.' });
    }
    const path = await supabaseStorage.uploadPdf(folder, req.file.originalname, req.file.buffer, req.file.mimetype);
    res.json({ success: true, path: path });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== EXAM TIME ENGINE API ===================== */
const ExamTimeEngine = require('./src/services/examTimeEngine');

app.post('/api/exam/start', requireAuth, async (req, res) => {
  try {
    const { examId, examType, courseId, timeSettings } = req.body;
    // التحقق من وجود محاولة مسلمة مسبقاً
    const existing = (await readData('examAttempts')) || [];
    var submitted = existing.find(function(a) {
      return a.userId === req.session.user.uid && a.courseId === courseId &&
        (a.status === 'submitted' || a.status === 'auto-submitted');
    });
    if (submitted) return res.json({ success: false, error: 'تم تسليم هذا الامتحان مسبقاً ولا يمكن إعادة أدائه.' });

    const attempt = await ExamTimeEngine.getOrCreateAttempt(
      req.session.user.uid, examId, examType, courseId, timeSettings
    );
    res.json({
      success: true,
      attempt: {
        id: attempt.id,
        startedAt: attempt.startTime,
        realEndTime: attempt.endTime,
        status: attempt.status,
        answers: attempt.answers || {}
      },
      serverTime: Date.now()
    });
  } catch (e) {
    if (e.code === 'AVAILABILITY') {
      return res.json({ success: false, error: safeErr(e), code: 'AVAILABILITY' });
    }
    res.status(500).json({ success: false, error: 'تعذر بدء الامتحان، حاول مرة أخرى.' });
  }
});

app.post('/api/exam/sync', requireAuth, async (req, res) => {
  try {
    const { attemptId } = req.body;
    const attempts = (await readData('examAttempts')) || [];
    const attempt = attempts.find(a => a.id === attemptId && a.userId === req.session.user.uid);
    if (!attempt) return res.json({ success: false, error: 'المحاولة غير موجودة' });

    const remaining = ExamTimeEngine.calculateRemaining(attempt.endTime);
    res.json({
      success: true,
      serverTime: Date.now(),
      remaining: remaining,
      status: attempt.status,
      realEndTime: attempt.endTime
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'خطأ في المزامنة' });
  }
});

app.post('/api/exam/save-answers', requireAuth, async (req, res) => {
  try {
    const { attemptId, answers } = req.body;
    const attempt = await ExamTimeEngine.saveAnswers(attemptId, req.session.user.uid, answers);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: safeErr(e) });
  }
});

app.post('/api/exam/submit', requireAuth, async (req, res) => {
  try {
    const { attemptId, answers } = req.body;
    const attempt = await ExamTimeEngine.submitAttempt(attemptId, req.session.user.uid, answers, false);

    // Grade the attempt server-side (without exposing correct answers to client)
    var score = 0, total = 0;
    try {
      if (attempt.courseId) {
        var courses = await readData('courses');
        var course = courses.find(c => c.id === attempt.courseId);
        if (course && course.quiz && course.quiz.questions) {
          var questions = course.quiz.questions;
          total = questions.length;
          var ans = attempt.answers || {};
          questions.forEach(function(q, idx) {
            if (ans[String(idx)] !== undefined && parseInt(ans[String(idx)]) === q.correct) {
              score++;
            }
          });
          await ExamTimeEngine.saveGrade(attemptId, req.session.user.uid, score, total);
        }
      }
    } catch(e) {}

    res.json({
      success: true,
      status: attempt.status,
      submittedAt: new Date().toISOString(),
      score: score,
      total: total
    });
  } catch (e) {
    res.json({ success: false, error: safeErr(e) });
  }
});

app.post('/api/exam/grade', requireAuth, async (req, res) => {
  try {
    const { attemptId, score, total } = req.body;
    await ExamTimeEngine.saveGrade(attemptId, req.session.user.uid, score, total);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: 'تعذر حفظ النتيجة' });
  }
});

app.get('/student/exam/:courseId', requireStudent, async (req, res) => {
  const courses = await readData('courses');
  const course = courses.find(c => c.id === req.params.courseId);
  if (!course || !course.quiz) return res.redirect('/student/courses');
  var existingAttempt = null;
  try {
    const attempts = (await readData('examAttempts')) || [];
    var submitted = attempts.find(function(a) {
      return a.userId === req.session.user.uid && a.courseId === req.params.courseId &&
        (a.status === 'submitted' || a.status === 'auto-submitted');
    });
    if (submitted) existingAttempt = submitted;
  } catch(e) {}
  res.render('student/exam', { course, title: `الاختبار - ${course.title} - المُميز`, existingAttempt: existingAttempt });
});

app.get('/student/question-bank', requireStudent, async (req, res) => {
  var courses = await readData('courses');
  var allBanks = await readData('questionBanks') || [];
  var u = req.session.user;
  var us = (u && u.stage) || '';
  var ug = (u && u.grade) || '';
  if (us) courses = courses.filter(function(c) { return c.stage === us || c.stage === 'all' || !c.stage; });
  if (ug) courses = courses.filter(function(c) { return c.grade === ug || !c.grade; });
  res.render('student/question-bank', { courses, allBanks, title: 'بنك الأسئلة - المُميز' });
});

app.get('/student/question-bank/:courseId', requireStudent, async (req, res) => {
  const courses = await readData('courses');
  const allBanks = await readData('questionBanks') || [];
  const course = courses.find(c => c.id === req.params.courseId);
  if (!course) return res.redirect('/student/question-bank');
  const courseBanks = allBanks.filter(b => b.courseId === req.params.courseId);
  if (!courseBanks.length) return res.redirect('/student/question-bank');
  res.render('student/question-bank-course', { course, courseBanks, title: `بنك أسئلة ${course.title} - المُميز` });
});

app.get('/student/notes', requireStudent, async (req, res) => {
  var courses = await readData('courses');
  var allNotes = await readData('notes');
  var u = req.session.user;
  var us = (u && u.stage) || '';
  var ug = (u && u.grade) || '';
  if (us) courses = courses.filter(function(c) { return c.stage === us || c.stage === 'all' || !c.stage; });
  if (ug) courses = courses.filter(function(c) { return c.grade === ug || !c.grade; });
  if (us) allNotes = allNotes.filter(function(n) { return !n.stage || n.stage === us; });
  if (ug) allNotes = allNotes.filter(function(n) { return !n.grade || n.grade === ug; });
  var isSubscribed = u && u.subscriptionStatus === 'active' && (!u.subscriptionEnd || new Date(u.subscriptionEnd) > new Date());
  res.render('student/notes', { courses, allNotes, isSubscribed: !!isSubscribed, title: 'المذكرات - المُميز' });
});

app.get('/student/reviews', requireStudent, async (req, res) => {
  var reviews = (await readData('reviews')) || [];
  var courses = (await readData('courses')) || [];
  var u = req.session.user;
  var us = (u && u.stage) || '';
  var ug = (u && u.grade) || '';
  if (us) reviews = reviews.filter(function(r) { return r.stage === us || r.stage === 'all' || !r.stage; });
  if (ug) reviews = reviews.filter(function(r) { return r.grade === ug || !r.grade; });
  var courseIdFilter = req.query.courseId;
  if (courseIdFilter) reviews = reviews.filter(function(r) { return r.courseId === courseIdFilter; });
  var filteredCourses = courses.filter(function(c) { return (!us || c.stage === us) && (!ug || c.grade === ug); });
  res.render('student/reviews', { reviews, courses: filteredCourses, currentCourseId: courseIdFilter || '', title: 'المراجعات - المُميز' });
});

app.get('/student/review/:id', requireStudent, async (req, res) => {
  const reviews = (await readData('reviews')) || [];
  const review = reviews.find(r => r.id === req.params.id);
  if (!review) return res.redirect('/student/reviews');
  // Storage can return arrays as objects with numeric keys - normalize so the template's .length works.
  if (review.videos && !Array.isArray(review.videos)) review.videos = Object.values(review.videos);
  if (review.pdfFiles && !Array.isArray(review.pdfFiles)) review.pdfFiles = Object.values(review.pdfFiles);
  var codeRequired = !!(review.accessCode && !req.session.reviewAccess);
  var codeValid = !!(req.session.reviewAccess && req.session.reviewAccess[review.id]);
  res.render('student/review-detail', { review, title: `${review.title} - المُميز`, codeRequired, codeValid });
});

// POST /api/student/verify-review-code — verify access code for a review
app.post('/api/student/verify-review-code', requireStudent, async (req, res) => {
  try {
    const { reviewId, code } = req.body;
    if (!reviewId || !code) return res.json({ success: false, error: 'الكود مطلوب' });
    const reviews = (await readData('reviews')) || [];
    const review = reviews.find(r => r.id === reviewId);
    if (!review) return res.json({ success: false, error: 'المراجعة غير موجودة' });
    if (String(code).trim() === String(review.accessCode).trim()) {
      if (!req.session.reviewAccess) req.session.reviewAccess = {};
      req.session.reviewAccess[reviewId] = true;
      return res.json({ success: true });
    }
    res.json({ success: false, error: 'الكود غير صحيح' });
  } catch (e) {
    res.status(500).json({ error: 'حدث خطأ' });
  }
});

app.get('/student/subscription', requireAuth, async (req, res) => {
  const subscriptions = await readData('subscriptions');
  var fresh = await readUserById(req.session.user.id);
  if (fresh) req.session.user = sessionUser(fresh);
  const user = req.session.user;
  const isGuest = req.session.demoMode;
  const userStage = user && user.stage;
  const filtered = subscriptions.filter(s => !s.stage || s.stage === userStage);
  var settingsSub = await readData('settings') || {};
  var refDiscSetting = settingsSub.referralDiscount != null ? settingsSub.referralDiscount : 25;
  res.render('student/subscription', { subscriptions: filtered, user, isGuest, refDiscSetting, shakeoutEnabled: shakeout.isConfigured(), title: 'الاشتراك - المُميز' });
});

app.get('/student/payment', requireAuth, async (req, res) => {
  const isGuest = req.session.demoMode;
  res.render('student/payment', { isGuest, title: 'طلب اشتراك - المُميز' });
});

app.post('/api/student/submit-payment', requireAuth, async (req, res) => {
  try {
    const { transactionId, amount, paymentMethod: method, receiptImage } = req.body;
    if (receiptImage) {
      var imgErr = validateReceiptImage(receiptImage);
      if (imgErr) return res.status(400).json({ error: imgErr });
    }
    const payments = await readData('payments') || [];
    const paymentId = 'PAY-' + Date.now();
    var r2ReceiptImage = receiptImage || '';
    if (receiptImage && storageConfig.isR2Enabled()) {
      try {
        const storage = getStorageService();
        var mime = receiptImage.split(';')[0].split(':')[1] || 'image/jpeg';
        var extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
        var ext = extMap[mime] || '.jpg';
        var raw = Buffer.from(receiptImage.split(',')[1] || receiptImage, 'base64');
        var objectKey = storage.generateObjectKey('payments', paymentId, 'receipt', 'receipt' + ext);
        await storage.upload({
          key: objectKey,
          body: raw,
          contentType: mime,
          visibility: 'private',
          metadata: { type: 'payment_receipt', entityId: paymentId, uploadedBy: req.session.user.id }
        });
        r2ReceiptImage = objectKey;
      } catch (e) {
        console.error('R2 upload error for payment receipt:', e.message);
        return res.status(500).json({ error: 'تعذر رفع الصورة، حاول مرة أخرى.' });
      }
    }
    const payment = {
      id: paymentId,
      userId: req.session.user.id,
      userName: req.session.user.name,
      transactionId, amount, method,
      receiptImage: r2ReceiptImage,
      status: 'pending',
      date: new Date().toISOString(),
      rejectReason: ''
    };
    payments.push(payment);
    await writeData('payments', payments);
    res.json({ success: true, payment });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

// ===================== SHAKE OUT PAYMENT GATEWAY =====================
const shakeout = require('./services/shakeout.service');

// ===================== SHAKE OUT ROUTES =====================

// POST /api/student/pay-subscription-shakeout — Create Shake Out invoice
app.post('/api/student/pay-subscription-shakeout', requireStudent, async (req, res) => {
  try {
    if (!shakeout.isConfigured()) return res.status(503).json({ error: 'Shake Out غير متاح حالياً' });
    var planName = req.body.planName;
    var price = parseInt(req.body.price);
    var planId = req.body.planId || '';
    if (!planName || !price) return res.status(400).json({ error: 'بيانات الخطة غير مكتملة' });
    var invoice = await shakeout.createInvoice(
      req.session.user.id,
      req.session.user.name,
      req.session.user.email,
      req.session.user.phone,
      { name: planName, price: price, durationDays: 30, stage: req.session.user.stage || '', period: 'شهرياً' },
      planId
    );
    res.json({ success: true, paymentUrl: invoice.paymentUrl });
  } catch (e) {
    console.error('[ShakeOut] createInvoice error:', e.message);
    res.status(500).json({ error: 'تعذر إنشاء عملية الدفع' });
  }
});

// POST /api/payments/shakeout/webhook — Shake Out payment webhook
app.post('/api/payments/shakeout/webhook', async (req, res) => {
  try {
    var result = await shakeout.handleWebhook(req.body);
    res.json(result);
  } catch (e) {
    var code = e.statusCode || 500;
    console.error('[ShakeOut] webhook error:', e.message);
    res.status(code).json({ error: safeErr(e) });
  }
});

// GET /student/shakeout-redirect — Shake Out redirect landing page
app.get('/student/shakeout-redirect', requireAuth, async (req, res) => {
  res.render('student/shakeout-redirect', { status: req.query.status || 'pending', title: 'الدفع - المُميز' });
});

app.get('/student/profile', requireStudent, async (req, res) => {
  var fresh = await readUserById(req.session.user.id);
  if (fresh) req.session.user = sessionUser(fresh);
  const u = req.session.user;
  const isSubscribed = u && u.subscriptionStatus === 'active' && (!u.subscriptionEnd || new Date(u.subscriptionEnd) > new Date());
  var invites = await readData('parentInvites') || [];
  var pendingInvite = invites.find(function(i) { return i.studentId === u.id && i.status === 'pending'; });
  res.render('student/profile', { title: 'حسابي - المُميز', isSubscribed: !!isSubscribed, parentInvitePending: !!pendingInvite, parentInviteLink: pendingInvite ? ('https://almumayaz.online/parent/invite/' + pendingInvite.token) : '', parentInviteEmail: pendingInvite ? (pendingInvite.parentEmail || '') : '' });
});

app.put('/api/student/profile', requireAuth, async (req, res) => {
  try {
    const prisma = getPrisma();
    const userId = req.session.user.id;
    const u = await prisma.user.findUnique({ where: { id: userId } });
    if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const isSubscribed = u.subscriptionStatus === 'active' && (!u.subscriptionEnd || new Date(u.subscriptionEnd) > new Date());
    const ALLOWED = ['name', 'phone', 'parentPhone', 'parentName', 'parentEmail', 'avatar', 'governorate'];
    const allowed = {};
    ALLOWED.forEach(function (k) { if (req.body[k] !== undefined) allowed[k] = req.body[k]; });
    if (!isSubscribed) {
      if (req.body.stage !== undefined) allowed.stage = req.body.stage;
      if (req.body.grade !== undefined) allowed.grade = req.body.grade;
    }
    if (allowed.avatar !== undefined && storageConfig.isR2Enabled()) {
      try {
        if (allowed.avatar) {
          var raw = Buffer.from(allowed.avatar.split(',')[1] || allowed.avatar, 'base64');
          var mime = allowed.avatar.split(';')[0].split(':')[1] || 'image/jpeg';
          var extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
          var ext = extMap[mime] || '.jpg';
          var validation = validateUpload({ buffer: raw, originalName: 'avatar' + ext, declaredMime: mime, type: 'avatar' });
          if (!validation.valid) return res.status(400).json({ error: validation.error });
          var storage = getStorageService();
          var objectKey = storage.generateObjectKey('avatars', userId, 'avatar', 'avatar' + ext);
          await storage.upload({ key: objectKey, body: raw, contentType: mime, visibility: 'public', metadata: { type: 'avatar', entityId: userId, uploadedBy: userId, uploadedAt: new Date().toISOString() } });
          allowed.avatar = objectKey;
        }
        if (u.avatar && !u.avatar.startsWith('data:')) {
          try { await getStorageService().delete(u.avatar); } catch (_) {}
        }
      } catch (e) {
        console.error('R2 upload error for avatar:', e.message);
        return res.status(500).json({ error: 'تعذر رفع الصورة، حاول مرة أخرى.' });
      }
    }
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { ...allowed, lastLogin: new Date() }
    });
    req.session.user = sessionUser(updated);
    var safeUser = {};
    var safeFields = ['id','name','email','phone','role','stage','grade','governorate','avatar','subscriptionStatus','subscriptionEnd','referralCode','parentName','parentPhone','parentEmail','fcmEnabled','phoneVerified'];
    safeFields.forEach(function(k) { if (updated[k] !== undefined) safeUser[k] = updated[k]; });
    if (safeUser.avatar && !safeUser.avatar.startsWith('data:') && storageConfig.isR2Enabled()) {
      try { safeUser.avatar = await getStorageService().createPublicUrl(safeUser.avatar); } catch (_) {}
    }
    res.json({ success: true, user: safeUser });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== STUDENT REFERRAL DISCOUNT ===================== */

app.post('/api/student/apply-referral', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || !code.startsWith('REF-')) return res.status(400).json({ error: 'كود الدعوة غير صالح' });

    const prisma = getPrisma();
    const userId = req.session.user.id;
    const referrer = await prisma.user.findFirst({ where: { referralCode: code, deletedAt: null } });
    if (!referrer) return res.status(404).json({ error: 'كود الدعوة غير موجود' });
    if (referrer.id === userId) return res.status(400).json({ error: 'لا يمكنك استخدام كود دعوتك الشخصي' });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (user.referralDiscount) return res.status(400).json({ error: 'لقد استخدمت كود دعوة من قبل' });
    if (user.referralUsedAt) {
      var daysSince = (Date.now() - new Date(user.referralUsedAt).getTime()) / 86400000;
      if (daysSince < 30) {
        var daysLeft = 30 - Math.floor(daysSince);
        return res.status(400).json({ error: 'يمكنك استخدام كود دعوة جديد بعد ' + daysLeft + ' يومًا' });
      }
    }

    var settingsRef = await readData('settings') || {};
    var refDiscount = settingsRef.referralDiscount != null ? settingsRef.referralDiscount : 25;

    // Update current user
    await prisma.user.update({
      where: { id: userId },
      data: { referralDiscount: refDiscount, referredBy: referrer.referralCode, referralUsedAt: new Date() }
    });

    // Track on referrer via Referral table + update referralDiscount on referrer
    await prisma.referral.create({
      data: { referrerId: referrer.id, referredId: userId, discount: refDiscount, code }
    }).catch(() => {});

    req.session.user = sessionUser({ ...user, referralDiscount: refDiscount, referredBy: referrer.referralCode });

    res.json({ success: true, discount: refDiscount, message: 'تم تطبيق خصم ' + refDiscount + '% على جميع خطط الاشتراك!' });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== CHAT ===================== */

app.get('/student/chat', requireStudent, (req, res) => {
  const user = req.session.user;
  const isGuest = !!req.session.demoMode;
  const chatId = isGuest ? (req.session.guestChatId || 'guest-' + Date.now()) : ('student-' + user.id);
  res.render('student/chat', { user, isGuest, chatId, title: 'اسأل عفيفي - المُميز' });
});

// Homework Chat
app.get('/student/homework-chat', requireStudent, (req, res) => {
  const user = req.session.user;
  const chatId = 'homework-' + user.id;
  res.render('student/homework-chat', { user, chatId, title: 'تسليم الواجب - المُميز' });
});

app.get('/student/comprehensive-exam', requireStudent, async (req, res) => {
  try {
    const user = req.session.user;
    const isGuest = req.session.demoMode;
    const examData = await readData('comprehensiveExam');
    if (!examData || !examData.questions || !examData.questions.length || examData.enabled === false) {
      return res.render('student/comprehensive-exam', { course: null, examFile: null, isGuest: isGuest, title: 'شامل المنهج - المُميز' });
    }
    const uid = user ? user.uid : (req.session.guestChatId || '');
    let existingAttempt = null;
    try {
      const attempts = (await readData('examAttempts')) || [];
      existingAttempt = attempts.find(function(a) {
        return a.userId === uid && a.examId === 'comprehensive' && (a.status === 'submitted' || a.status === 'auto-submitted' || a.status === 'passed' || a.status === 'failed');
      }) || null;
    } catch(e) {}
    if (!existingAttempt && user && user.id) {
      try {
        const prisma = getPrisma();
        const prismaAttempts = await prisma.examAttempt.findMany({
          where: { userId: user.id, deletedAt: null },
          orderBy: { createdAt: 'desc' }
        });
        const compAttempt = prismaAttempts.find(function(a) {
          return a.examId === 'comprehensive' && (a.status === 'passed' || a.status === 'failed' || a.status === 'submitted' || a.status === 'auto-submitted');
        });
        if (compAttempt) {
          existingAttempt = {
            userId: compAttempt.userId,
            courseId: compAttempt.courseId,
            score: Number(compAttempt.score) || 0,
            total: Number(compAttempt.total) || 0,
            status: compAttempt.status,
            answers: compAttempt.answers || [],
            createdAt: compAttempt.createdAt
          };
        }
      } catch(e) {}
    }
    const quizDone = existingAttempt && existingAttempt.status === 'passed';
    res.render('student/comprehensive-exam', {
      course: { quiz: { title: examData.title || 'اختبار شامل المنهج', questions: examData.questions, timeSettings: examData.timeSettings, passPercentage: examData.passPercentage || 60, id: 'comprehensive' }, id: 'comprehensive' },
      examFile: examData,
      isGuest: isGuest,
      title: 'اختبار شامل المنهج - المُميز',
      existingAttempt: existingAttempt,
      quizDone: quizDone
    });
  } catch (e) {
    res.render('student/comprehensive-exam', { course: null, examFile: null, isGuest: false, title: 'شامل المنهج - المُميز' });
  }
});

app.get('/api/student/comprehensive-exam/download', requireStudent, async (req, res) => {
  try {
    const exam = await readData('comprehensiveExam');
    if (!exam || !exam.filePath) return res.status(404).json({ error: 'غير متاح' });

    const { path } = exam;
    const filename = exam.title || 'comprehensive-exam.docx';
    const safeFilename = filename.replace(/"/g, '');

    const signed = storageConfig.isR2Enabled()
      ? await getStorageService().createSignedUrl(path, 300)
      : await supabaseStorage.createSignedUrl(path, 60);

    const upstream = await fetch(signed);
    if (!upstream.ok) return res.status(502).end('Storage error');

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeFilename + '"');
    res.setHeader('Content-Length', buf.length);
    res.status(200).end(buf);
  } catch (e) {
    console.error('[comprehensive-exam download] error:', e && e.message);
    if (!res.headersSent) res.redirect('/student/comprehensive-exam');
  }
});

/* ===================== PARENT ACCOUNT SYSTEM ===================== */

function requireParent(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'parent') return res.redirect('/parent-login');
  next();
}

// Send parent invite (student side)
app.post('/api/student/send-parent-invite', requireAuth, async (req, res) => {
  try {
    const { parentName, parentPhone, parentEmail } = req.body;
    console.log('[invite] received: name=' + parentName + ' phone=' + parentPhone + ' email=' + (parentEmail || '(empty)'));
    if (!parentName || !parentPhone) return res.status(400).json({ error: 'يرجى إدخال اسم ورقم هاتف ولي الأمر' });

    var prisma = getPrisma();
    var { transactionData } = require('./prisma-bridge');
    var token = 'PINVITE-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    var existingToken = null;
    var inviteLink = null;
    var inviteObj = null;

    // Atomic RTDB transaction to create/update parent invite
    await transactionData('parentInvites', function(current) {
      var invites = Array.isArray(current) ? current.slice() : [];
      var existing = invites.find(function(i) { return i.studentId === req.session.user.id && i.status === 'pending'; });
      if (existing) {
        existing.parentName = parentName;
        existing.parentPhone = parentPhone;
        if (parentEmail) existing.parentEmail = parentEmail;
        existingToken = existing.token;
        inviteLink = 'https://almumayaz.online/parent/invite/' + existing.token;
        inviteObj = existing;
      } else {
        var expiresDate = new Date();
        expiresDate.setDate(expiresDate.getDate() + 30);
        var invite = {
          id: 'PINV-' + Date.now(),
          token: token,
          parentName: parentName,
          parentPhone: parentPhone,
          parentEmail: parentEmail || '',
          studentId: req.session.user.id,
          studentName: req.session.user.name,
          studentStage: req.session.user.stage || '',
          studentGrade: req.session.user.grade || '',
          status: 'pending',
          createdAt: new Date().toISOString(),
          expiresAt: expiresDate.toISOString()
        };
        invites.push(invite);
        inviteLink = 'https://almumayaz.online/parent/invite/' + token;
        inviteObj = invite;
      }
      return invites;
    });

    // Save parent info to student profile
    await prisma.user.update({
      where: { id: req.session.user.id },
      data: { parentName, parentPhone, parentEmail: parentEmail || '' }
    });
    req.session.user.parentName = parentName;
    req.session.user.parentPhone = parentPhone;
    req.session.user.parentEmail = parentEmail || '';

    if (existingToken && parentEmail) {
      var existingHtml = emailService.inviteEmailHtml(parentName, req.session.user.name, inviteLink);
      var resent = await emailService.sendMail(parentEmail, 'دعوة لمتابعة الطالب - منصة المُميز', existingHtml);
      console.log('[invite] resent to ' + parentEmail + ': ' + (resent ? 'OK' : 'FAILED'));
    }

    // Send invite link to parent email
    if (!existingToken && parentEmail && parentEmail.indexOf('@') > 0) {
      console.log('[invite] will send to ' + parentEmail);
      var inviteHtml = emailService.inviteEmailHtml(parentName, req.session.user.name, inviteLink);
      var emailSent = await emailService.sendMail(parentEmail, 'دعوة لمتابعة الطالب - منصة المُميز', inviteHtml);
      console.log('[invite] sendMail result: ' + (emailSent ? 'OK' : 'FAILED'));
    } else {
      console.log('[invite] SKIP - no valid email');
    }

    res.json({ success: true, inviteLink: inviteLink, invite: inviteObj, emailSent: !!(parentEmail) });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

// Parent invite acceptance page
app.get('/parent/invite/:token', async (req, res) => {
  try {
    var invites = await readData('parentInvites') || [];
    var invite = invites.find(i => i.token === req.params.token && i.status === 'pending');
    if (!invite) return res.render('parent/invite', { invite: null, error: 'رابط الدعوة غير صالح أو منتهي الصلاحية' });
    if (req.session.user) {
      if (req.session.user.role === 'parent') return res.redirect('/parent/dashboard');
      return res.redirect('/student');
    }
    res.render('parent/invite', { invite: invite, error: null });
  } catch (e) {
    res.status(500).send('حدث خطأ: ');
  }
});

// Accept invite - set password and create parent account
app.post('/api/parent/accept-invite', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password || password.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    var invites = await readData('parentInvites') || [];
    var idx = invites.findIndex(i => i.token === token && i.status === 'pending');
    if (idx === -1) return res.status(404).json({ error: 'رابط الدعوة غير صالح أو منتهي الصلاحية' });
    var invite = invites[idx];
    var prisma2 = getPrisma();
    // Check if parent already exists with this phone
    var existingParent = await prisma2.user.findFirst({ where: { role: 'parent', phone: invite.parentPhone, deletedAt: null } });
    if (existingParent) {
      // Link additional child to existing parent
      await prisma2.childRelation.upsert({
        where: { parentId_childId: { parentId: existingParent.id, childId: invite.studentId } },
        create: { parentId: existingParent.id, childId: invite.studentId },
        update: {}
      });
      invites[idx].status = 'accepted';
      invites[idx].acceptedAt = new Date().toISOString();
      invites[idx].parentUserId = existingParent.id;
      await writeData('parentInvites', invites);
      await prisma2.user.update({ where: { id: invite.studentId }, data: { parentId: existingParent.id } });
      return res.json({ success: true, message: 'تم ربط الطالب بحساب ولي الأمر الحالي' });
    }
    // Create parent user with local password
    var parentId = 'PARENT-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
    var passwordHash = await scryptHash(password);
    await prisma2.user.create({
      data: {
        id: parentId, uid: parentId,
        name: invite.parentName, phone: invite.parentPhone,
        email: invite.parentEmail || '', passwordHash,
        role: 'parent',
        createdAt: new Date(), lastLogin: new Date(),
      }
    });
    await prisma2.childRelation.create({ data: { parentId, childId: invite.studentId } });
    await prisma2.user.update({ where: { id: invite.studentId }, data: { parentId } });
    // Mark invite as accepted
    invites[idx].status = 'accepted';
    invites[idx].acceptedAt = new Date().toISOString();
    invites[idx].parentUserId = parentId;
    await writeData('parentInvites', invites);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

// Parent login
app.post('/api/auth/parent-login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'يرجى إدخال رقم الهاتف وكلمة المرور' });
    var prisma3 = getPrisma();
    var parent = await prisma3.user.findFirst({ where: { role: 'parent', phone, deletedAt: null } });
    if (!parent) return res.status(401).json({ error: 'رقم الهاتف أو كلمة المرور غير صحيحة' });
    const ok = await verifyPassword(parent.passwordHash, password);
    if (!ok) return res.status(401).json({ error: 'رقم الهاتف أو كلمة المرور غير صحيحة' });
    if (typeof parent.passwordHash === 'string' && !parent.passwordHash.startsWith('scrypt$') && password) {
      var hash = await scryptHash(password);
      await prisma3.user.update({ where: { id: parent.id }, data: { passwordHash: hash } });
      parent.passwordHash = hash;
    }
    req.session = { user: sessionUser(parent), darkMode: req.session.darkMode || false };
    res.json({ success: true, redirect: '/parent/dashboard' });
  } catch (e) {
    console.error('parent-login error:', e);
    res.status(500).json({ error: 'تعذر تسجيل الدخول، حاول لاحقاً' });
  }
});

// Parent dashboard
app.get('/parent/dashboard', requireParent, async (req, res) => {
  try {
    var prisma4 = getPrisma();
    var parent = await prisma4.user.findUnique({ where: { id: req.session.user.id } });
    if (!parent) return res.redirect('/logout');
    req.session.user = sessionUser(parent);
    var childRelations = await prisma4.childRelation.findMany({ where: { parentId: parent.id } });
    var childrenIds = childRelations.map(cr => cr.childId);
    if (childrenIds.length === 0) return res.render('parent/dashboard', { children: [], selectedChild: null, stats: {}, notifications: [], user: parent });
    var children = await prisma4.user.findMany({ where: { id: { in: childrenIds }, deletedAt: null } });
    if (children.length === 0) return res.render('parent/dashboard', { children: [], selectedChild: null, stats: {}, notifications: [], user: parent });
    var selectedChildId = req.query.child || childrenIds[0];
    var selectedChild = children.find(u => u.id === selectedChildId);
    if (!selectedChild) selectedChild = children[0];

    // Compute stats for selected child from normalized tables
    var courses = await readData('courses') || [];
    var completedLessonsArr = await prisma4.lessonProgress.findMany({ where: { studentId: selectedChild.id, completed: true } });
    var completedLessons = completedLessonsArr.length;
    var totalLessons = 0;
    courses.forEach(function(c) {
      totalLessons += (c.sections || []).reduce(function(sum, s) { return sum + (s.lessons || []).length; }, 0);
    });
    var progressPercentage = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;

    // Exam stats from ExamAttempt table
    var examAttempts2 = await prisma4.examAttempt.findMany({ where: { userId: selectedChild.id, deletedAt: null } });
    var completedExams = examAttempts2.length;
    var avgScore = completedExams > 0 ? Math.round(examAttempts2.reduce(function(sum, r) { return sum + (Number(r.score) || 0); }, 0) / completedExams) : 0;
    var lastExamResult = examAttempts2.length > 0 ? examAttempts2[examAttempts2.length - 1] : null;

    var totalHours = Math.round(completedLessons * 0.75);

    // Recent activity from progress + exam data
    var recentActivity = [];
    completedLessonsArr.forEach(function(lp) {
      recentActivity.push({ type: 'lesson', text: 'أكمل درس', date: lp.completedAt ? lp.completedAt.toISOString() : new Date().toISOString() });
    });
    examAttempts2.forEach(function(r) {
      recentActivity.push({ type: 'exam', text: 'حل اختبار ' + (r.examName || ''), date: r.endTime ? r.endTime.toISOString() : (r.createdAt ? r.createdAt.toISOString() : new Date().toISOString()) });
    });
    recentActivity.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });

    var lastLesson = recentActivity.find(function(a) { return a.type === 'lesson'; });
    var lastExam = recentActivity.find(function(a) { return a.type === 'exam'; });

    var stats = {
      completedLessons: completedLessons,
      completedExams: completedExams,
      avgScore: avgScore,
      totalHours: totalHours,
      progressPercentage: progressPercentage,
      lastLesson: lastLesson ? lastLesson.text : null,
      lastExam: lastExam ? lastExam.text : null,
      lastExamScore: lastExamResult ? Number(lastExamResult.score) : null,
      recentActivity: recentActivity
    };

    // Notifications from Notification table
    var notifications = await prisma4.notification.findMany({ where: { userId: selectedChild.id, deletedAt: null }, orderBy: { createdAt: 'desc' } });

    res.render('parent/dashboard', { children: children, selectedChild: selectedChild, stats: stats, notifications: notifications, user: parent });
  } catch (e) {
    res.status(500).send('حدث خطأ: ');
  }
});

// API: Get child progress data
app.get('/api/parent/child-progress/:childId', requireParent, async (req, res) => {
  try {
    var prisma5 = getPrisma();
    var childRelation = await prisma5.childRelation.findUnique({
      where: { parentId_childId: { parentId: req.session.user.id, childId: req.params.childId } }
    });
    if (!childRelation) return res.status(403).json({ error: 'غير مصرح بالوصول' });
    var child = await prisma5.user.findUnique({ where: { id: req.params.childId } });
    if (!child) return res.status(404).json({ error: 'الطالب غير موجود' });
    res.json({ success: true, child: { id: child.id, name: child.name, grade: child.grade, stage: child.stage, subscriptionStatus: child.subscriptionStatus, phone: child.phone } });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== STUDENT SUBSCRIPTION API ===================== */

app.post('/api/student/subscribe', requireAuth, async (req, res) => {
  try {
    const { planName, price, transactionId, paymentMethod, receiptImage } = req.body;
    if (!transactionId) return res.status(400).json({ error: 'يرجى إدخال كود العملية' });
    if (receiptImage) {
      var imgErr = validateReceiptImage(receiptImage);
      if (imgErr) return res.status(400).json({ error: imgErr });
    }
    const subs = await readData('subscriptions') || [];
    const sub = subs.find(s => s.name === planName);
    const subRequests = await readData('subRequests') || [];
    const requestId = 'SUB-' + Date.now();
    var r2ReceiptImage = receiptImage || '';
    if (receiptImage && storageConfig.isR2Enabled()) {
      try {
        const storage = getStorageService();
        var mime = receiptImage.split(';')[0].split(':')[1] || 'image/jpeg';
        var extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
        var ext = extMap[mime] || '.jpg';
        var raw = Buffer.from(receiptImage.split(',')[1] || receiptImage, 'base64');
        var objectKey = storage.generateObjectKey('subrequests', requestId, 'receipt', 'receipt' + ext);
        await storage.upload({
          key: objectKey,
          body: raw,
          contentType: mime,
          visibility: 'private',
          metadata: { type: 'subscription-receipt', entityId: requestId, uploadedBy: req.session.user.id, uploadedAt: new Date().toISOString() }
        });
        r2ReceiptImage = objectKey;
      } catch (e) {
        console.error('R2 upload error for subscription receipt:', e.message);
        return res.status(500).json({ error: 'تعذر رفع الصورة، حاول مرة أخرى.' });
      }
    }
    const request = {
      id: requestId,
      userId: req.session.user.id,
      userName: req.session.user.name,
      userPhone: req.session.user.phone || '',
      planName, price, transactionId, paymentMethod: paymentMethod || 'vodafone-cash',
      receiptImage: r2ReceiptImage,
      planId: sub ? sub.id : '',
      planStage: req.session.user.stage || (sub ? (sub.stage || '') : ''),
      period: sub ? (sub.period || '') : '',
      durationDays: sub ? (sub.durationDays || 30) : 30,
      status: 'pending',
      date: new Date().toISOString(),
      discount: req.session.user.referralDiscount || 0
    };
    await fsCore.setDocument('subRequests/' + request.id, request);
    getPrisma().subRequest.create({
      data: { id: requestId, userId: req.session.user.id, userName: req.session.user.name || '', userPhone: (req.session.user.phone || ''), planName, price: price ? Number(price) : 0, transactionId: transactionId || '', paymentMethod: paymentMethod || 'vodafone-cash', receiptImage: r2ReceiptImage || '', planId: sub ? (sub.id || '') : '', planStage: req.session.user.stage || (sub ? (sub.stage || '') : ''), period: sub ? (sub.period || '') : '', durationDays: sub ? (sub.durationDays || 30) : 30, status: 'pending', discount: req.session.user.referralDiscount || 0, date: new Date() }
    }).catch(function(e) { console.error('[subscribe] prisma create error:', e.message); });
    // Notify all admins via FCM + email
    try {
      var adminList = await getPrisma().user.findMany({ where: { role: 'admin', deletedAt: null } });
      console.log('[subscribe] found', adminList.length, 'admins');
      for (var ai = 0; ai < adminList.length; ai++) {
        var adminUser = adminList[ai];
        if (adminUser.email) {
          try {
            var subHtml = emailService.subscriptionEmailHtml(req.session.user.name || 'طالب', req.session.user.phone || '', planName, price);
            await emailService.sendMail(adminUser.email, '📋 طلب اشتراك جديد من ' + (req.session.user.name || 'طالب'), subHtml);
            console.log('[subscribe] email sent to', adminUser.email);
          } catch (e) { console.error('[subscribe] email error for', adminUser.id, ':', e.message); }
        }
        if (adminUser.fcmToken) {
          try {
            console.log('[subscribe] sending push to admin', adminUser.id, 'token length:', adminUser.fcmToken.length);
            var subMsg = { token: adminUser.fcmToken, notification: { title: 'طلب اشتراك جديد 📋', body: 'من ' + (req.session.user.name || 'طالب') + ' - ' + planName }, data: { url: '/admin/sub-requests' } };
            const subResp = await admin.messaging().send(subMsg);
            fcmLog.add({ userId: adminUser.id, title: 'طلب اشتراك', messageId: subResp || 'unknown', success: true, error: null });
          } catch (e) {
            console.error('[subscribe] push error for', adminUser.id, ':', e.code || e.message);
            fcmLog.add({ userId: adminUser.id, title: 'طلب اشتراك', messageId: null, success: false, error: e.code || e.message });
            if (e.code === 'messaging/invalid-registration-token' || e.code === 'messaging/registration-token-not-registered') {
              await getPrisma().user.update({ where: { id: adminUser.id }, data: { fcmToken: '' } });
              console.log('[subscribe] cleared invalid token for', adminUser.id);
            }
          }
        } else {
          console.log('[subscribe] admin', adminUser.id, 'has no fcmToken — push skipped');
        }
      }
    } catch (e) { console.error('[subscribe] admin notify error:', e.message); }
    res.json({ success: true, request });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.get('/api/admin/sub-requests', requireAdmin, async (req, res) => {
  try {
    const subRequests = await readData('subRequests') || [];
    if (storageConfig.isR2Enabled()) {
      const storage = getStorageService();
      for (const sr of subRequests) {
        if (sr.receiptImage && !sr.receiptImage.startsWith('data:')) {
          try { sr.receiptImage = await storage.createSignedUrl(sr.receiptImage, 300); } catch (_) {}
        }
      }
    }
    const userIds = [...new Set(subRequests.map(sr => sr.userId).filter(Boolean))];
    const userList = await getPrisma().user.findMany({ where: { OR: userIds.map(id => ({ id })), deletedAt: null } });
    const enriched = subRequests.reverse().map(function(sr) {
      const u = userList.find(function(x) { return x.id === sr.userId; });
      if (u && u.referredBy) {
        var ref = userList.find(function(x) { return x.referralCode === u.referredBy; });
        if (!ref) ref = userList.find(function(x) { return x.id === u.referredBy; });
        sr.referredByName = ref ? (ref.name || '') : '';
      } else {
        sr.referredByName = '';
      }
      return sr;
    });
    res.json({ success: true, requests: enriched });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.put('/api/admin/sub-requests/:id', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const subRequests = await readData('subRequests') || [];
    const idx = subRequests.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الطلب غير موجود' });
    subRequests[idx].status = status;
    await writeData('subRequests', subRequests);
    if (status === 'approved') {
      // Activate user subscription
      var subUser = await getPrisma().user.findFirst({ where: { id: subRequests[idx].userId, deletedAt: null } });
      if (subUser) {
        var durDays = parseInt(subRequests[idx].durationDays) || 30;
        var subEnd = new Date(Date.now() + durDays * 24 * 60 * 60 * 1000);
        await getPrisma().user.update({
          where: { id: subUser.id },
          data: {
            subscriptionStatus: 'active',
            subscriptionStart: new Date(),
            subscriptionEnd: subEnd,
            subscribedStage: subRequests[idx].planStage || subUser.subscribedStage || '',
            planName: subRequests[idx].planName || '',
            planPeriod: subRequests[idx].period || '',
            referralDiscount: subUser.referralDiscount > 0 ? 0 : subUser.referralDiscount,
            referralUsedAt: subUser.referralDiscount > 0 ? new Date() : subUser.referralUsedAt,
          }
        });
        // Also create UserSubscription record
        try {
          await getPrisma().userSubscription.create({
            data: {
              userId: subUser.id,
              planName: subRequests[idx].planName || 'عام',
              status: 'active',
              startDate: new Date(),
              endDate: subEnd,
              period: subRequests[idx].period || 'شهرياً',
              stage: subRequests[idx].planStage || '',
            }
          });
        } catch (_) {}
      }
      // Record the payment for revenue tracking
      try {
        const payments = await readData('payments') || [];
        payments.push({
          id: 'PAY-' + Date.now(),
          userId: subRequests[idx].userId,
          userName: subRequests[idx].userName,
          transactionId: subRequests[idx].transactionId || '',
          amount: Number(subRequests[idx].price) || 0,
          method: subRequests[idx].paymentMethod || 'vodafone-cash',
          planName: subRequests[idx].planName || '',
          status: 'approved',
          date: new Date().toISOString(),
          rejectReason: ''
        });
        await writeData('payments', payments);
      } catch(e) { console.error('Failed to record payment for sub-request:', e.message); }
      sendFCM(subRequests[idx].userId, 'تم تفعيل الاشتراك 🎉', 'مرحباً ' + (subRequests[idx].userName || '') + '! تم تفعيل اشتراكك في منصة المُميز. يمكنك الآن مشاهدة جميع المحاضرات.', '/student/subscription');
    } else if (status === 'rejected') {
      sendFCM(subRequests[idx].userId, 'لم يتم الموافقة على طلب الاشتراك', 'عذراً ' + (subRequests[idx].userName || '') + '، لم تتم الموافقة على طلب الاشتراك الخاص بك. يرجى التواصل مع الدعم الفني.', '/student/subscription');
    }
    res.json({ success: true, request: subRequests[idx] });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.get('/api/admin/sub-requests/sync', requireAdmin, async (req, res) => {
  try {
    var data = await require('./data-store').readData('subRequests');
    var fbAdmin = require('./prisma-bridge');
    await fbAdmin.fbSet('subRequests', data || []);
    await fbAdmin.writeData('subRequests', data || []);
    res.json({ success: true, count: (data || []).length });
  } catch (e) { console.error('[sub-requests]', e.message); res.status(500).json({ error: safeErr(e) }); }
});

app.delete('/api/admin/sub-requests/:id', requireAdmin, async (req, res) => {
  try {
    const subRequests = await readData('subRequests') || [];
    const idx = subRequests.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الطلب غير موجود' });
    if (storageConfig.isR2Enabled()) {
      var deleted = subRequests[idx];
      if (deleted.receiptImage && !deleted.receiptImage.startsWith('data:')) {
        try { await getStorageService().delete(deleted.receiptImage); } catch (_) {}
      }
    }
    subRequests.splice(idx, 1);
    // Write to local + Firebase
    await writeData('subRequests', subRequests);
    // Force direct Firebase write as backup
    var fbAdmin = require('./prisma-bridge');
    if (fbAdmin.fbSet) {
      try { await fbAdmin.fbSet('subRequests', subRequests); } catch(e) { console.error('Direct fbSet failed:', e.message); }
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== CHAT API (SERVER-SIDE) ===================== */

const { fbRead, fbSet, fbPush, fbRemove } = require('./prisma-bridge');

function chatId(req) {
  if (req.session.demoMode) {
    if (!req.session.guestChatId) req.session.guestChatId = 'guest-' + Date.now() + '-' + Math.random().toString(36).substr(2,6);
    return req.session.guestChatId;
  }
  return 'student-' + (req.session.user.id || 'guest');
}

function senderId(req) { return req.session.user.id || (req.session.guestChatId || 'guest'); }

app.get('/api/student/chat/messages', requireStudent, async (req, res) => {
  try {
    const cid = chatId(req);
    const data = await fbRead('chats/' + cid + '/messages');
    const msgs = data ? Object.keys(data).map(function(k) { var m=data[k]; m._key=k; return m; }).sort(function(a,b){return (a.timestamp||0)-(b.timestamp||0)}) : [];
    if (storageConfig.isR2Enabled()) {
      const storage = getStorageService();
      for (var i = 0; i < msgs.length; i++) {
        if (msgs[i].image && msgs[i].image.startsWith('chat-images/')) {
          msgs[i].image = await storage.createSignedUrl(msgs[i].image, 3600);
        }
      }
    }
    res.json({ success: true, messages: msgs });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

async function saveNotification(target, targetValue, title, body, url) {
  try {
    const notifications = await readData('notifications') || [];
    notifications.push({
      id: 'notif-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      title, body, target, targetValue, url: url || '/',
    });
    await writeData('notifications', notifications);
  } catch (e) { console.error('saveNotification error:', e.message); }
}

app.post('/api/student/chat/send', requireStudent, async (req, res) => {
  try {
    const cid = chatId(req);
    const { text, image } = req.body;
    if (!text && !image) return res.status(400).json({ error: 'لا يمكن إرسال رسالة فارغة' });
    const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
    var r2Image = image || '';
    if (image && storageConfig.isR2Enabled()) {
      try {
        const raw = Buffer.from(image.split(',')[1] || image, 'base64');
        const mime = image.split(';')[0].split(':')[1] || 'image/jpeg';
        const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
        const ext = extMap[mime] || '.jpg';
        const validation = validateUpload({ buffer: raw, originalName: 'chat' + ext, declaredMime: mime, type: 'chatImage' });
        if (!validation.valid) return res.status(400).json({ error: validation.error });
        const storage = getStorageService();
        const objectKey = storage.generateObjectKey('chat-images', cid.replace('student-', ''), msgId, 'chat' + ext);
        await storage.upload({ key: objectKey, body: raw, contentType: mime, visibility: 'private', metadata: { type: 'chat-image', entityId: msgId, conversationId: cid, uploadedBy: req.session.user.id, uploadedAt: new Date().toISOString() } });
        r2Image = objectKey;
      } catch (e) {
        console.error('R2 upload error for chat image:', e.message);
        return res.status(500).json({ error: 'تعذر رفع الصورة، حاول مرة أخرى.' });
      }
    }
    const msg = { senderId: senderId(req), senderName: req.session.user.name || 'زائر', timestamp: Date.now(), read: false, text: text || '', image: r2Image };
    const key = await fbPush('chats/' + cid + '/messages', msg);
    const studentId = req.session.user.id || (req.session.guestChatId || '');
    const preview = text ? (text.length > 80 ? text.slice(0,80) + '...' : text) : '📷 صورة';
    // Send push to all admins + store notification in DB
    var prisma = getPrisma();
    var adminUsers = await prisma.user.findMany({ where: { role: 'admin', deletedAt: null } });
    adminUsers.forEach(async function(adminUser) {
      if (adminUser.fcmToken) {
        try {
          await sendFCM(adminUser.id, 'رسالة جديدة من ' + (req.session.user.name || 'طالب'), preview, '/admin/chat/' + encodeURIComponent(studentId));
        } catch(e) {
          console.error('Chat push error for', adminUser.id, ':', e.code || e.message);
        }
      } else {
        console.log("[CHAT PUSH] no fcmToken for admin", adminUser.id);
      }
    });
    var firstAdmin = adminUsers[0] || {};
    await saveNotification('admin', firstAdmin.id || 'admin-1', 'رسالة جديدة من ' + (req.session.user.name || 'طالب'), preview, '/admin/chat/' + encodeURIComponent(studentId));
    res.json({ success: true, key: key, message: msg });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

app.get('/api/admin/chat/:studentId/messages', requireAdmin, async (req, res) => {
  try {
    var studentId = req.params.studentId;
    if (!/^[a-zA-Z0-9_\-]+$/.test(studentId)) return res.status(400).json({ error: 'Invalid student ID' });
    const chatId = 'student-' + studentId;
    const data = await fbRead('chats/' + chatId + '/messages');
    const msgs = data ? Object.keys(data).map(function(k) { var m=data[k]; m._key=k; return m; }).sort(function(a,b){return (a.timestamp||0)-(b.timestamp||0)}) : [];
    if (storageConfig.isR2Enabled()) {
      const storage = getStorageService();
      for (var i = 0; i < msgs.length; i++) {
        if (msgs[i].image && msgs[i].image.startsWith('chat-images/')) {
          msgs[i].image = await storage.createSignedUrl(msgs[i].image, 3600);
        }
      }
    }
    res.json({ success: true, messages: msgs });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

app.post('/api/admin/chat/:studentId/send', requireAdmin, async (req, res) => {
  try {
    const rawId = req.params.studentId;
    if (!/^[a-zA-Z0-9_\-]+$/.test(rawId)) return res.status(400).json({ error: 'Invalid student ID' });
    const studentId = rawId.indexOf('student-') === 0 ? rawId : ('student-' + rawId);
    const chatId = studentId;
    const actualUserId = rawId.indexOf('student-') === 0 ? rawId.slice(8) : rawId;
    const { text, image } = req.body;
    if (!text && !image) return res.status(400).json({ error: 'لا يمكن إرسال رسالة فارغة' });
    const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
    var r2Image = image || '';
    if (image && storageConfig.isR2Enabled()) {
      try {
        const raw = Buffer.from(image.split(',')[1] || image, 'base64');
        const mime = image.split(';')[0].split(':')[1] || 'image/jpeg';
        const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
        const ext = extMap[mime] || '.jpg';
        const validation = validateUpload({ buffer: raw, originalName: 'chat' + ext, declaredMime: mime, type: 'chatImage' });
        if (!validation.valid) return res.status(400).json({ error: validation.error });
        const storage = getStorageService();
        const objectKey = storage.generateObjectKey('chat-images', chatId.replace('student-', ''), msgId, 'chat' + ext);
        await storage.upload({ key: objectKey, body: raw, contentType: mime, visibility: 'private', metadata: { type: 'chat-image', entityId: msgId, conversationId: chatId, uploadedBy: req.session.user.id, uploadedAt: new Date().toISOString() } });
        r2Image = objectKey;
      } catch (e) {
        console.error('R2 upload error for admin chat image:', e.message);
        return res.status(500).json({ error: 'تعذر رفع الصورة، حاول مرة أخرى.' });
      }
    }
    const msg = { senderId: 'teacher', senderName: 'محمد عفيفي', timestamp: Date.now(), read: false, text: text || '', image: r2Image };
    const key = await fbPush('chats/' + chatId + '/messages', msg);
    const preview = text ? (text.length > 80 ? text.slice(0,80) + '...' : text) : '📷 صورة';
    // Send push to student
    await sendFCM(actualUserId, 'رسالة جديدة من الأستاذ محمد عفيفي 📩', preview, '/student/chat');
    // Store notification in DB so the student sees it in their notification center.
    // targetValue must match the student's session user.id (without the 'student-' prefix).
    await saveNotification('student', actualUserId, 'رسالة جديدة من الأستاذ محمد عفيفي 📩', preview, '/student/chat');
    res.json({ success: true, key: key, message: msg });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

app.delete('/api/admin/chat/:studentId', requireAdmin, async (req, res) => {
  try {
    var studentId = req.params.studentId;
    if (!/^[a-zA-Z0-9_\-]+$/.test(studentId)) return res.status(400).json({ error: 'Invalid student ID' });
    const chatId = 'student-' + studentId;
    if (storageConfig.isR2Enabled()) {
      const data = await fbRead('chats/' + chatId + '/messages');
      if (data) {
        const storage = getStorageService();
        var keys = Object.values(data).filter(function(m) { return m.image && m.image.startsWith('chat-images/'); }).map(function(m) { return m.image; });
        await Promise.all(keys.map(function(k) { return storage.delete(k).catch(function(e) { console.error('R2 delete error for ' + k + ':', e.message); }); }));
      }
    }
    await fbRemove('chats/' + chatId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

app.put('/api/student/chat/read', requireStudent, async (req, res) => {
  try {
    const cid = chatId(req);
    const data = await fbRead('chats/' + cid + '/messages');
    if (!data) return res.json({ success: true });
    Object.keys(data).forEach(function(k) { if (data[k].senderId === 'teacher') data[k].read = true; });
    await fbSet('chats/' + cid + '/messages', data);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

// Homework Chat API
app.get('/api/student/homework-chat/messages', requireStudent, async (req, res) => {
  try {
    const cid = 'homework-' + req.session.user.id;
    const data = await fbRead('homework-chats/' + cid + '/messages');
    const msgs = data ? Object.keys(data).map(function(k) { var m=data[k]; m._key=k; return m; }).sort(function(a,b){return (a.timestamp||0)-(b.timestamp||0)}) : [];
    if (storageConfig.isR2Enabled()) {
      const storage = getStorageService();
      for (var i = 0; i < msgs.length; i++) {
        if (msgs[i].image && msgs[i].image.startsWith('homework-chat-images/')) {
          msgs[i].image = await storage.createSignedUrl(msgs[i].image, 3600);
        }
      }
    }
    res.json({ success: true, messages: msgs });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

app.post('/api/student/homework-chat/send', requireStudent, async (req, res) => {
  try {
    const cid = 'homework-' + req.session.user.id;
    const { text, image } = req.body;
    if (!text && !image) return res.status(400).json({ error: 'لا يمكن إرسال رسالة فارغة' });
    const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
    var r2Image = image || '';
    if (image && storageConfig.isR2Enabled()) {
      try {
        const raw = Buffer.from(image.split(',')[1] || image, 'base64');
        const mime = image.split(';')[0].split(':')[1] || 'image/jpeg';
        const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
        const ext = extMap[mime] || '.jpg';
        const validation = validateUpload({ buffer: raw, originalName: 'homework' + ext, declaredMime: mime, type: 'chatImage' });
        if (!validation.valid) return res.status(400).json({ error: validation.error });
        const storage = getStorageService();
        const objectKey = storage.generateObjectKey('homework-chat-images', req.session.user.id, msgId, 'homework' + ext);
        await storage.upload({ key: objectKey, body: raw, contentType: mime, visibility: 'private', metadata: { type: 'homework-chat-image', entityId: msgId, conversationId: cid, uploadedBy: req.session.user.id, uploadedAt: new Date().toISOString() } });
        r2Image = objectKey;
      } catch (e) {
        console.error('R2 upload error for homework chat image:', e.message);
        return res.status(500).json({ error: 'تعذر رفع الصورة، حاول مرة أخرى.' });
      }
    }
    const msg = { senderId: 'student-' + req.session.user.id, senderName: req.session.user.name || 'طالب', timestamp: Date.now(), read: false, text: text || '', image: r2Image };
    const key = await fbPush('homework-chats/' + cid + '/messages', msg);
    // Notify all admins
    var prisma = getPrisma();
    var adminUsers = await prisma.user.findMany({ where: { role: 'admin', deletedAt: null } });
    adminUsers.forEach(async function(adminUser) {
      if (adminUser.fcmToken) {
        try {
          const preview = text ? (text.length > 80 ? text.slice(0,80) + '...' : text) : '📷 صورة الواجب';
          await sendFCM(adminUser.id, 'واجب جديد من ' + (req.session.user.name || 'طالب'), preview, '/admin/homework-chat/' + req.session.user.id);
        } catch(e) {
          console.error('Homework chat push error for', adminUser.id, ':', e.code || e.message);
        }
      } else {
        console.log("[HOMEWORK CHAT PUSH] no fcmToken for admin", adminUser.id);
      }
    });
    var firstAdmin = adminUsers[0] || {};
    await saveNotification('admin', firstAdmin.id || 'admin-1', 'واجب جديد من ' + (req.session.user.name || 'طالب'), preview, '/admin/homework-chat/' + req.session.user.id);
    res.json({ success: true, key: key, message: msg });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

app.put('/api/student/homework-chat/read', requireStudent, async (req, res) => {
  try {
    const cid = 'homework-' + req.session.user.id;
    const data = await fbRead('homework-chats/' + cid + '/messages');
    if (!data) return res.json({ success: true });
    Object.keys(data).forEach(function(k) { if (data[k].senderId === 'teacher') data[k].read = true; });
    await fbSet('homework-chats/' + cid + '/messages', data);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

// Admin Homework Chat endpoints
app.get('/api/admin/homework-chat/:studentId/messages', requireAdmin, async (req, res) => {
  try {
    var studentId = req.params.studentId;
    if (!/^[a-zA-Z0-9_\-]+$/.test(studentId)) return res.status(400).json({ error: 'Invalid student ID' });
    const chatId = 'homework-' + studentId;
    const data = await fbRead('homework-chats/' + chatId + '/messages');
    const msgs = data ? Object.keys(data).map(function(k) { var m=data[k]; m._key=k; return m; }).sort(function(a,b){return (a.timestamp||0)-(b.timestamp||0)}) : [];
    if (storageConfig.isR2Enabled()) {
      const storage = getStorageService();
      for (var i = 0; i < msgs.length; i++) {
        if (msgs[i].image && msgs[i].image.startsWith('homework-chat-images/')) {
          msgs[i].image = await storage.createSignedUrl(msgs[i].image, 3600);
        }
      }
    }
    res.json({ success: true, messages: msgs });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

app.post('/api/admin/homework-chat/:studentId/send', requireAdmin, async (req, res) => {
  try {
    const studentId = req.params.studentId;
    if (!/^[a-zA-Z0-9_\-]+$/.test(studentId)) return res.status(400).json({ error: 'Invalid student ID' });
    const chatId = 'homework-' + studentId;
    const { text, image } = req.body;
    if (!text && !image) return res.status(400).json({ error: 'لا يمكن إرسال رسالة فارغة' });
    const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
    var r2Image = image || '';
    if (image && storageConfig.isR2Enabled()) {
      try {
        const raw = Buffer.from(image.split(',')[1] || image, 'base64');
        const mime = image.split(';')[0].split(':')[1] || 'image/jpeg';
        const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
        const ext = extMap[mime] || '.jpg';
        const validation = validateUpload({ buffer: raw, originalName: 'homework' + ext, declaredMime: mime, type: 'chatImage' });
        if (!validation.valid) return res.status(400).json({ error: validation.error });
        const storage = getStorageService();
        const objectKey = storage.generateObjectKey('homework-chat-images', studentId, msgId, 'homework' + ext);
        await storage.upload({ key: objectKey, body: raw, contentType: mime, visibility: 'private', metadata: { type: 'homework-chat-image', entityId: msgId, conversationId: chatId, uploadedBy: req.session.user.id, uploadedAt: new Date().toISOString() } });
        r2Image = objectKey;
      } catch (e) {
        console.error('R2 upload error for admin homework chat image:', e.message);
        return res.status(500).json({ error: 'تعذر رفع الصورة، حاول مرة أخرى.' });
      }
    }
    const msg = { senderId: 'teacher', senderName: 'الأستاذ', timestamp: Date.now(), read: false, text: text || '', image: r2Image };
    const key = await fbPush('homework-chats/' + chatId + '/messages', msg);
    const preview = text ? (text.length > 80 ? text.slice(0,80) + '...' : text) : '📷 صورة';
    await sendFCM(studentId, 'رد من الأستاذ على واجبك 📩', preview, '/student/homework-chat');
    await saveNotification('student', studentId, 'رد من الأستاذ على واجبك 📩', preview, '/student/homework-chat');
    res.json({ success: true, key: key, message: msg });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

app.delete('/api/admin/homework-chat/:studentId', requireAdmin, async (req, res) => {
  try {
    var studentId = req.params.studentId;
    if (!/^[a-zA-Z0-9_\-]+$/.test(studentId)) return res.status(400).json({ error: 'Invalid student ID' });
    const chatId = 'homework-' + studentId;
    if (storageConfig.isR2Enabled()) {
      const data = await fbRead('homework-chats/' + chatId + '/messages');
      if (data) {
        const storage = getStorageService();
        var keys = Object.values(data).filter(function(m) { return m.image && m.image.startsWith('homework-chat-images/'); }).map(function(m) { return m.image; });
        await Promise.all(keys.map(function(k) { return storage.delete(k).catch(function(e) { console.error('R2 delete error for ' + k + ':', e.message); }); }));
      }
    }
    await fbRemove('homework-chats/' + chatId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

app.put('/api/admin/homework-chat/:studentId/read', requireAdmin, async (req, res) => {
  try {
    var studentId = req.params.studentId;
    if (!/^[a-zA-Z0-9_\-]+$/.test(studentId)) return res.status(400).json({ error: 'Invalid student ID' });
    const cid = 'homework-' + studentId;
    const data = await fbRead('homework-chats/' + cid + '/messages');
    if (!data) return res.json({ success: true });
    Object.keys(data).forEach(function(k) { if (data[k].senderId === 'student-' + studentId) data[k].read = true; });
    await fbSet('homework-chats/' + cid + '/messages', data);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

app.put('/api/admin/chat/:studentId/read', requireAdmin, async (req, res) => {
  try {
    var studentId = req.params.studentId;
    if (!/^[a-zA-Z0-9_\-]+$/.test(studentId)) return res.status(400).json({ error: 'Invalid student ID' });
    const chatId = 'student-' + studentId;
    const data = await fbRead('chats/' + chatId + '/messages');
    if (!data) return res.json({ success: true });
    Object.keys(data).forEach(function(k) { if (data[k].senderId !== 'teacher') data[k].read = true; });
    await fbSet('chats/' + chatId + '/messages', data);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

/* ===================== PROGRESS TRACKING ===================== */

app.post('/api/student/progress', requireAuth, async (req, res) => {
  try {
    const { courseId, lessonId, completed, percentage, position } = req.body;
    const uid = req.session.user.uid || req.session.user.id;
    const prisma = getPrisma();
    await prisma.lessonProgress.upsert({
      where: { id: lpId },
      create: { id: lpId, studentId: uid, lessonId, completed: !!completed, watchTime: percentage || 0, lastAccess: new Date() },
      update: { completed: completed ? true : undefined, watchTime: percentage !== undefined ? percentage : undefined, lastAccess: new Date() },
    });
    const cp = { completedLessons: completed ? [lessonId] : [], percentage: percentage || 0, positions: position ? { [lessonId]: Math.max(0, Math.floor(Number(position) || 0)) } : {} };
    res.json({ success: true, progress: cp });
  } catch (e) {
    console.error('progress save error:', e.message, e.stack);
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.get('/api/student/progress/:courseId', requireAuth, async (req, res) => {
  try {
    const prisma = getPrisma();
    const lessons = await prisma.lessonProgress.findMany({
      where: { studentId: req.session.user.id }
    });
    const completedLessons = lessons.filter(l => l.completed).map(l => l.lessonId);
    const watchTimes = {};
    lessons.forEach(l => { if (l.watchTime) watchTimes[l.lessonId] = l.watchTime; });
    const progress = { completedLessons, percentage: 0, watchTime: watchTimes };
    res.json({ success: true, progress });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

// ===================== ANALYTICS ENGINE =====================

// Video heartbeat — tracks watch progress every ~15s
app.post('/api/analytics/video/heartbeat', requireAuth, async (req, res) => {
  try {
    const { courseId, lessonId, position, duration, watchedSeconds, forceComplete } = req.body;
    const uid = req.session.user.uid;
    if (!courseId || !lessonId) return res.status(400).json({ error: 'courseId and lessonId are required' });
    const result = await analytics.trackVideoHeartbeat(uid, courseId, lessonId, position || 0, duration || 1, watchedSeconds || 0, !!forceComplete);
    // Write progress to VideoProgress + LessonProgress tables
    try {
      const prisma = getPrisma();
      const lpId = uid + '_' + lessonId;
      const pct = Math.min(100, Math.round((Number(position || 0) / (Number(duration || 1) || 1)) * 100));
      await prisma.lessonProgress.upsert({
        where: { id: lpId },
        create: { id: lpId, studentId: uid, lessonId, watchTime: Number(watchedSeconds || 0), lastAccess: new Date() },
        update: { watchTime: { increment: Number(watchedSeconds || 0) }, lastAccess: new Date() },
      }).catch(() => {});
      if (forceComplete) {
        await prisma.lessonProgress.update({ where: { id: lpId }, data: { completed: true, completedAt: new Date() } }).catch(() => {});
      }
    } catch (pe) { console.error('heartbeat progress sync error:', pe.message); }
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// Get watch status for a specific lesson (resume position, completion status)
app.get('/api/analytics/video/status', requireAuth, async (req, res) => {
  try {
    const { courseId, lessonId } = req.query;
    const uid = req.session.user.uid;
    const a = await analytics.getAnalyticsFresh(uid);
    const lk = courseId + '_' + lessonId;
    const wl = (a.watchHistory || {}).lessons || {};
    const lp = (a.lessonProgress || {})[lk] || {};
    const wh = wl[lk] || {};
    res.json({
      success: true,
      resumePosition: wh.resumePosition || 0,
      completionPercent: wh.completionPercent || 0,
      completed: lp.status === 'completed' || false,
      status: lp.status || 'not_started',
      totalSeconds: wh.totalSeconds || 0
    });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// PDF open tracking
app.post('/api/analytics/pdf/open', requireAuth, async (req, res) => {
  try {
    const { courseId, lessonId, lessonTitle } = req.body;
    await analytics.trackPdfOpen(req.session.user.uid, courseId, lessonId, lessonTitle);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// Quiz submit — save attempt results
app.post('/api/analytics/quiz/submit', requireAuth, async (req, res) => {
  try {
    const { courseId, quizId, quizTitle, score, total, correct, wrong, timeTaken, answers } = req.body;
    const result = await analytics.trackQuizSubmit(req.session.user.uid, courseId, quizId, quizTitle, score, total, correct, wrong, timeTaken);
    // Calculate pass/fail BEFORE any DB writes (avoids scope/hoisting issues)
    let lessonPassPct = 60;
    try {
      const courses = await readData('courses');
      const course = (courses || []).find(c => c.id === courseId);
      const lesson = course ? (course.lessons || []).find(l => l.id === quizId) : null;
      lessonPassPct = (lesson && lesson.quiz && lesson.quiz.passPercentage) || (course && course.quiz && course.quiz.passPercentage) || 60;
    } catch(e) {}
    const nScore = Number(score) || 0;
    const nTotal = Number(total) || 1;
    const pct = Math.round(nScore / nTotal * 100);
    const passed = pct >= lessonPassPct;
    // Save results to normalized Prisma tables
    try {
      const prisma = getPrisma();
      const userId = req.session.user.id;
      // Prevent re-taking if already passed
      if (passed) {
        const prevPass = await prisma.examAttempt.findFirst({
          where: { userId, examId: quizId, status: 'passed' }
        });
        if (prevPass) return res.json({ success: true, passed: true, percentage: pct, required: lessonPassPct, score: nScore, total: nTotal, alreadyPassed: true });
      }
      const attemptId = `${userId}_${quizId}_${Date.now()}`;
      await prisma.examAttempt.create({
        data: {
          id: attemptId,
          userId,
          courseId,
          type: 'quiz',
          examId: quizId,
          status: passed ? 'passed' : 'failed',
          score: nScore,
          total: nTotal,
          answers: Array.isArray(answers) ? answers : [],
          endTime: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      if (passed) {
        // Mark lesson as completed in LessonProgress
        const existingLp = await prisma.lessonProgress.findFirst({
          where: { studentId: userId, lessonId: quizId },
        });
        if (!existingLp) {
          await prisma.lessonProgress.create({
            data: {
              id: `${userId}_${quizId}`,
              studentId: userId,
              lessonId: quizId,
              completed: true,
              completedAt: new Date(),
              watchTime: 0,
              lastAccess: new Date(),
            },
          });
        } else if (!existingLp.completed) {
          await prisma.lessonProgress.update({
            where: { id: existingLp.id },
            data: { completed: true, completedAt: new Date() },
          });
        }
        if (!req.session.quizDoneLessons) req.session.quizDoneLessons = [];
        if (!req.session.quizDoneLessons.includes(quizId)) {
          req.session.quizDoneLessons.push(quizId);
        }
      }
      // Refresh session user from Prisma
      const fresh = await getPrisma().user.findUnique({ where: { id: userId } });
      if (fresh) req.session.user = sessionUser(fresh);
    } catch (pe) { console.error('quiz submit save error:', pe.message); }
    res.json({ success: true, passed: passed, percentage: pct, required: lessonPassPct, score: nScore, total: nTotal });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// Get own analytics (student) — replaces GET /api/student/my-progress logic
app.get('/api/analytics/student', requireAuth, async (req, res) => {
  try {
    const data = await analytics.getStudentDashboardData(req.session.user.uid);
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// Migration for existing users (admin only, one-time)
app.post('/api/analytics/migrate', requireAdmin, async (req, res) => {
  try {
    const result = await analytics.migrateAll();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// Admin: full analytics overview (engine v2)
app.get('/api/admin/analytics/v2/overview', requireAdmin, async (req, res) => {
  try {
    const data = await analytics.getAdminAnalytics();
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// Admin: delete ALL analytics data (from DB too)
app.post('/api/admin/analytics/v2/delete-all', requireAdmin, async (req, res) => {
  try {
    const result = await analytics.deleteAllAnalytics();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// Admin: save a snapshot/backup of current analytics
app.post('/api/admin/analytics/v2/backup', requireAdmin, async (req, res) => {
  try {
    const result = await analytics.backupAnalytics();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// Admin: remove analytics records not linked to a real user (orphans like uid "0")
app.post('/api/admin/analytics/v2/cleanup-orphans', requireAdmin, async (req, res) => {
  try {
    const result = await analytics.cleanupOrphanAnalytics();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// Admin: single student detail (engine v2)
app.get('/api/admin/analytics/v2/student/:studentId', requireAdmin, async (req, res) => {
  try {
    const data = await analytics.getAdminStudentDetail(req.params.studentId);
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// Admin: reset all analytics (delete studentAnalytics RTDB path + clear users progress/examResults)
app.post('/api/admin/analytics/reset-all', requireAdmin, async (req, res) => {
  try {
    const { fbRemove } = require('./prisma-bridge');
    // 1. Delete old studentAnalytics store in RTDB
    try { await fbRemove('studentAnalytics'); } catch (e) {}
    // 2. Clear all LessonProgress and soft-delete ExamAttempt records
    const prisma = getPrisma();
    await prisma.lessonProgress.deleteMany({});
    await prisma.examAttempt.updateMany({ data: { deletedAt: new Date() } });
    res.json({ success: true, message: 'تم حذف جميع التحليلات بنجاح' });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// ===================== ANALYTICS API =====================

// Helper: parse "MM:SS" duration to minutes
function parseDuration(dur) {
  if (!dur || dur === '00:00') return 0;
  var parts = dur.split(':');
  if (parts.length === 2) return parseInt(parts[0]) + parseInt(parts[1]) / 60;
  return 0;
}

// GET /api/admin/analytics/overview — Teacher dashboard overview stats
app.get('/api/admin/analytics/overview', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    var courses = await readData('courses');
    var now = new Date();
    var day = 86400000;

    var [totalStudents, activeToday, activeThisWeek, activeThisMonth,
          activeSubs, expiredSubs, examStats] = await Promise.all([
      prisma.user.count({ where: { role: 'student', deletedAt: null } }),
      prisma.user.count({ where: { role: 'student', deletedAt: null, lastLogin: { gte: new Date(now.getTime() - day) } } }),
      prisma.user.count({ where: { role: 'student', deletedAt: null, lastLogin: { gte: new Date(now.getTime() - 7 * day) } } }),
      prisma.user.count({ where: { role: 'student', deletedAt: null, lastLogin: { gte: new Date(now.getTime() - 30 * day) } } }),
      prisma.user.count({ where: { role: 'student', deletedAt: null, subscriptionStatus: 'active' } }),
      prisma.user.count({ where: { role: 'student', deletedAt: null, OR: [{ subscriptionStatus: 'expired' }, { subscriptionEnd: { lt: now } }] } }),
      prisma.examAttempt.aggregate({ _avg: { score: true }, _count: true, where: { deletedAt: null } })
    ]);
    var avgQuizScore = Math.round(Number(examStats._avg.score) || 0);

    res.json({
      totalStudents, activeToday, activeThisWeek, activeThisMonth,
      activeSubscriptions: activeSubs, expiredSubscriptions: expiredSubs,
      averageCompletion: 0,
      averageQuizScore: avgQuizScore,
      totalCourses: courses.length
    });
  } catch(e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// GET /api/admin/analytics/students?sort=most|least&limit=10&page=1&pageSize=20
app.get('/api/admin/analytics/students', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    var courses = await readData('courses');
    var sort = req.query.sort || 'most';
    var page = Math.max(1, parseInt(req.query.page) || 1);
    var pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || parseInt(req.query.limit) || 20));
    var skip = (page - 1) * pageSize;

    var lessonCountMap = {};
    courses.forEach(function(c) {
      if (c.lessons) lessonCountMap[c.id] = c.lessons.length;
    });

    var totalStudents = await prisma.user.count({ where: { role: 'student', deletedAt: null } });

    var students = await prisma.user.findMany({
      where: { role: 'student', deletedAt: null },
      include: { lessonProgress: true, examAttempts: { where: { deletedAt: null } } },
      orderBy: sort === 'least' ? { lastLogin: { sort: 'asc', nulls: 'last' } } : { lastLogin: { sort: 'desc', nulls: 'last' } },
      take: pageSize,
      skip: skip
    });

    var now = Date.now();
    var day = 86400000;

    var scored = students.map(function(s) {
      var completedCount = s.lessonProgress.filter(function(lp) { return lp.completed; }).length;
      var totalWatchMinutes = Math.round(s.lessonProgress.reduce(function(sum, lp) { return sum + (lp.watchTime || 0); }, 0) / 60);
      var totalLessons = Object.values(lessonCountMap).reduce(function(a, b) { return a + b; }, 0);
      var avgQuiz = 0;
      if (s.examAttempts && s.examAttempts.length) {
        var sum = s.examAttempts.reduce(function(t, e) { return t + Number(e.score || 0); }, 0);
        avgQuiz = Math.round(sum / s.examAttempts.length);
      }
      var completionPct = totalLessons > 0 ? Math.round((completedCount / totalLessons) * 100) : 0;
      var lessonRatio = totalLessons > 0 ? (completedCount / totalLessons) * 100 : 0;
      var loginRecency = 0;
      if (s.lastLogin) {
        var daysSinceLogin = (now - s.lastLogin.getTime()) / day;
        loginRecency = Math.max(0, 100 - daysSinceLogin * 3.33);
      }
      var activityScore = Math.round((completionPct * 0.4) + (lessonRatio * 0.3) + (avgQuiz * 0.2) + (loginRecency * 0.1));
      return {
        id: s.id, name: s.name || '', grade: s.grade || '', stage: s.stage || '',
        governorate: s.governorate || '', subscriptionStatus: s.subscriptionStatus || '',
        completedLessons: completedCount, totalLessons: totalLessons,
        completionPct: completionPct, totalWatchMinutes: totalWatchMinutes,
        avgQuizScore: avgQuiz, activityScore: activityScore,
        lastLogin: s.lastLogin || '', createdAt: s.createdAt || ''
      };
    });

    scored.sort(function(a, b) { return sort === 'least' ? a.activityScore - b.activityScore : b.activityScore - a.activityScore; });
    res.json({ students: scored, total: totalStudents, page: page, pageSize: pageSize });
  } catch(e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// GET /api/admin/analytics/lessons — Lesson analytics
app.get('/api/admin/analytics/lessons', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    var courses = await readData('courses');
    var allProgress = await prisma.lessonProgress.findMany({ where: { completed: true } });
    var result = [];

    courses.forEach(function(c) {
      if (!c.lessons || !c.lessons.length) return;
      c.lessons.forEach(function(l) {
        var courseProgress = allProgress.filter(function(lp) { return lp.courseId === c.id; });
        var lessonCompletions = courseProgress.filter(function(lp) { return lp.lessonId === l.id; });
        var studentCount = new Set(courseProgress.map(function(lp) { return lp.studentId; })).size;
        result.push({
          courseId: c.id, courseTitle: c.title, lessonId: l.id, lessonTitle: l.title,
          duration: l.duration, totalStudents: studentCount,
          completedCount: lessonCompletions.length,
          completionRate: studentCount > 0 ? Math.round((lessonCompletions.length / studentCount) * 100) : 0
        });
      });
    });

    res.json(result);
  } catch(e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// GET /api/admin/analytics/quizzes — Quiz analytics
app.get('/api/admin/analytics/quizzes', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    var courses = await readData('courses');
    var result = [];

    var quizAttempts = await prisma.examAttempt.findMany({ where: { deletedAt: null, type: 'quiz' } });
    courses.forEach(function(c) {
      if (!c.quiz || !c.quiz.questions || !c.quiz.questions.length) return;
      var scores = quizAttempts.filter(function(a) { return a.courseId === c.id; }).map(function(a) { return Number(a.score || 0); });
      var titleMatch = quizAttempts.filter(function(a) { return a.examId === c.quiz.title; }).map(function(a) { return Number(a.score || 0); });
      scores = scores.concat(titleMatch);
      if (scores.length) {
        var sum = scores.reduce(function(a, b) { return a + b; }, 0);
        var passCount = scores.filter(function(s) { return s >= 50; }).length;
        result.push({
          courseId: c.id, courseTitle: c.title, quizTitle: c.quiz.title,
          totalQuestions: c.quiz.questions.length, attempts: scores.length,
          averageScore: Math.round(sum / scores.length),
          highestScore: Math.max.apply(null, scores),
          lowestScore: Math.min.apply(null, scores),
          passRate: Math.round((passCount / scores.length) * 100)
        });
      }
    });

    res.json(result);
  } catch(e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// GET /api/admin/analytics/student/:studentId — Full student progress (teacher view)
app.get('/api/admin/analytics/student/:studentId', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    var courses = await readData('courses');
    var student = await prisma.user.findUnique({
      where: { id: req.params.studentId }, include: { lessonProgress: true, examAttempts: { where: { deletedAt: null } } }
    });
    if (!student || student.role !== 'student') return res.status(404).json({ error: 'الطالب غير موجود' });

    var now = Date.now();
    var day = 86400000;
    var totalCompleted = 0;
    var totalLessons = 0;
    var totalWatchSeconds = 0;
    var courseProgress = [];

    courses.forEach(function(c) {
      if (!c.lessons) return;
      var courseLP = student.lessonProgress.filter(function(lp) { return lp.courseId === c.id; });
      var completed = courseLP.filter(function(lp) { return lp.completed; }).map(function(lp) { return lp.lessonId; });
      totalLessons += c.lessons.length;
      totalCompleted += completed.length;
      courseLP.forEach(function(lp) { totalWatchSeconds += (lp.watchTime || 0); });

      courseProgress.push({
        courseId: c.id, courseTitle: c.title,
        percentage: totalLessons > 0 ? Math.round((totalCompleted / totalLessons) * 100) : 0,
        completedCount: completed.length, totalCount: c.lessons.length,
        lessons: c.lessons.map(function(l) { return { id: l.id, title: l.title, completed: completed.includes(l.id), duration: l.duration }; })
      });
    });

    var quizResults = student.examAttempts.map(function(e) { return { examName: e.examId || e.type, score: Number(e.score || 0), date: e.endTime || e.createdAt }; });
    var recentActivity = quizResults.map(function(r) { return { type: 'finished_quiz', quizName: r.examName, score: r.score, date: r.date }; });
    student.lessonProgress.filter(function(lp) { return lp.completed; }).forEach(function(lp) {
      recentActivity.push({ type: 'completed_lesson', courseId: lp.courseId, lessonId: lp.lessonId, date: lp.completedAt || lp.lastAccess });
    });
    recentActivity.sort(function(a, b) { return new Date(b.date || 0) - new Date(a.date || 0); });
    recentActivity = recentActivity.slice(0, 50);

    var avgQuiz = 0;
    if (quizResults.length) {
      var sum = quizResults.reduce(function(t, r) { return t + r.score; }, 0);
      avgQuiz = Math.round(sum / quizResults.length);
    }
    var completionPct = totalLessons > 0 ? Math.round((totalCompleted / totalLessons) * 100) : 0;
    var loginRecency = student.lastLogin ? Math.max(0, 100 - ((now - student.lastLogin.getTime()) / day) * 3.33) : 0;
    var activityScore = Math.round((completionPct * 0.4) + (completionPct * 0.3) + (avgQuiz * 0.2) + (loginRecency * 0.1));

    res.json({
      student: {
        id: student.id, name: student.name, email: student.email, phone: student.phone,
        grade: student.grade, stage: student.stage, governorate: student.governorate,
        subscriptionStatus: student.subscriptionStatus,
        subscriptionStart: student.subscriptionStart, subscriptionEnd: student.subscriptionEnd,
        createdAt: student.createdAt, lastLogin: student.lastLogin
      },
      progress: {
        completedLessons: totalCompleted, remainingLessons: totalLessons - totalCompleted, totalLessons: totalLessons,
        completionPct: completionPct, totalWatchMinutes: Math.round(totalWatchSeconds / 60),
        avgQuizScore: avgQuiz, activityScore: activityScore, completedQuizzes: quizResults.length
      },
      courseProgress: courseProgress, quizResults: quizResults, recentActivity: recentActivity
    });
  } catch(e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// GET /api/student/my-progress — Student's own progress
app.get('/api/student/my-progress', requireAuth, async (req, res) => {
  try {
    var prisma = getPrisma();
    var courses = await readData('courses');
    var student = await prisma.user.findUnique({
      where: { id: req.session.user.id }, include: { lessonProgress: true, examAttempts: { where: { deletedAt: null } } }
    });
    if (!student) return res.status(404).json({ error: 'المستخدم غير موجود' });

    var now = Date.now();
    var day = 86400000;
    var totalCompleted = 0;
    var totalLessons = 0;
    var totalWatchSeconds = 0;
    var courseProgress = [];

    courses.forEach(function(c) {
      if (!c.lessons) return;
      var courseLP = student.lessonProgress.filter(function(lp) { return lp.courseId === c.id; });
      var completed = courseLP.filter(function(lp) { return lp.completed; }).map(function(lp) { return lp.lessonId; });
      totalLessons += c.lessons.length;
      totalCompleted += completed.length;
      courseLP.forEach(function(lp) { totalWatchSeconds += (lp.watchTime || 0); });

      courseProgress.push({
        courseId: c.id, courseTitle: c.title,
        percentage: totalLessons > 0 ? Math.round((totalCompleted / totalLessons) * 100) : 0,
        completedCount: completed.length, totalCount: c.lessons.length
      });
    });

    var quizResults = student.examAttempts.map(function(e) { return { examName: e.examId || e.type, score: Number(e.score || 0), date: e.endTime || e.createdAt }; });
    var avgQuiz = 0;
    if (quizResults.length) {
      var sum = quizResults.reduce(function(t, r) { return t + r.score; }, 0);
      avgQuiz = Math.round(sum / quizResults.length);
    }
    var totalWatchMinutes = Math.round(totalWatchSeconds / 60);
    var completionPct = totalLessons > 0 ? Math.round((totalCompleted / totalLessons) * 100) : 0;
    var loginRecency = 100;
    if (student.lastLogin) {
      var daysSince = (now - student.lastLogin.getTime()) / day;
      loginRecency = Math.max(0, 100 - daysSince * 3.33);
    }
    var activityScore = Math.round((completionPct * 0.4) + (completionPct * 0.3) + (avgQuiz * 0.2) + (loginRecency * 0.1));

    // Achievements
    var achievements = [];
    if (totalCompleted >= 1) achievements.push({ id: 'first-lesson', title: 'أول محاضرة', desc: 'أكملت أول محاضرة', icon: 'fa-star', unlocked: true });
    if (quizResults.length >= 1) achievements.push({ id: 'first-quiz', title: 'أول اختبار', desc: 'أتممت أول اختبار', icon: 'fa-check-circle', unlocked: true });
    if (totalCompleted >= 10) achievements.push({ id: '10-lessons', title: '10 محاضرات', desc: 'أكملت 10 محاضرات', icon: 'fa-graduation-cap', unlocked: true });
    if (totalCompleted >= 25) achievements.push({ id: '25-lessons', title: '25 محاضرة', desc: 'أكملت 25 محاضرة', icon: 'fa-trophy', unlocked: true });
    if (totalCompleted >= 50) achievements.push({ id: '50-lessons', title: '50 محاضرة', desc: 'أكملت 50 محاضرة', icon: 'fa-crown', unlocked: true });
    if (totalWatchMinutes >= 1200) achievements.push({ id: '20-hours', title: '20 ساعة', desc: 'شاهدت 20 ساعة من المحاضرات', icon: 'fa-clock', unlocked: true });
    if (totalWatchMinutes >= 600) achievements.push({ id: '10-hours', title: '10 ساعات', desc: 'شاهدت 10 ساعات من المحاضرات', icon: 'fa-clock', unlocked: true });
    if (avgQuiz >= 90) achievements.push({ id: 'top-quiz', title: 'امتياز', desc: 'متوسط درجاتك في الاختبارات 90% فأكثر', icon: 'fa-star', unlocked: true });
    if (avgQuiz >= 75 && avgQuiz < 90) achievements.push({ id: 'good-quiz', title: 'جيد جداً', desc: 'متوسط درجاتك في الاختبارات 75% فأكثر', icon: 'fa-thumbs-up', unlocked: true });
    if (completionPct >= 100) achievements.push({ id: 'all-done', title: 'المنهج كامل', desc: 'أكملت كل المحاضرات', icon: 'fa-medal', unlocked: true });

    // Streak (rough calculation based on lastLogin)
    var streakDays = 0;
    if (student.lastLogin) {
      var daysSince = Math.round((now - student.lastLogin.getTime()) / day);
      streakDays = daysSince <= 1 ? 1 : 0;
    }

    // Recent activity
    var recentActivity = [];
    if (student.progress) {
      Object.keys(student.progress).forEach(function(cid) {
        var p = student.progress[cid];
        if (!p) return;
        var course = courses.find(function(c) { return c.id === cid; });
        if (p.completedLessons) {
          p.completedLessons.forEach(function(lid) {
            recentActivity.push({
              type: 'completed_lesson',
              courseTitle: course ? course.title : '',
              courseId: cid,
              lessonId: lid,
              icon: 'fa-check-circle',
              color: '#059669'
            });
          });
        }
      });
    }
    quizResults.forEach(function(r) {
      recentActivity.push({
        type: 'finished_quiz',
        quizName: r.examName || '',
        score: r.score || 0,
        icon: 'fa-question-circle',
        color: '#7c3aed',
        date: r.date || ''
      });
    });
    recentActivity.sort(function(a, b) { return new Date(b.date || 0) - new Date(a.date || 0); });
    recentActivity = recentActivity.slice(0, 30);

    // Unlocked achievements count
    var unlockedCount = achievements.filter(function(a) { return a.unlocked; }).length;

    res.json({
      progress: {
        completedLessons: totalCompleted,
        remainingLessons: totalLessons - totalCompleted,
        totalLessons: totalLessons,
        completionPct: completionPct,
        totalWatchMinutes: Math.round(totalWatchMinutes),
        avgQuizScore: avgQuiz,
        activityScore: activityScore,
        completedQuizzes: quizResults.length,
        streakDays: streakDays
      },
      courseProgress: courseProgress,
      quizResults: quizResults,
      achievements: achievements,
      unlockedAchievements: unlockedCount,
      totalAchievements: 10,
      recentActivity: recentActivity
    });
  } catch(e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// ===================== ANALYTICS PAGES =====================

app.get('/admin/analytics', requireAdmin, async (req, res) => {
  try {
    res.render('admin/analytics', { title: 'تحليلات المنصة - الإدارة' });
  } catch(e) {
    res.status(500).send('خطأ في تحميل التحليلات');
  }
});

app.get('/admin/student-progress', requireAdmin, async (req, res) => {
  try {
    res.render('admin/student-progress', { title: 'تقدم الطلاب - الإدارة', sid: req.query.sid || '' });
  } catch(e) {
    res.status(500).send('خطأ في تحميل تقدم الطلاب');
  }
});

/* ===================== ADMIN ROUTES ===================== */

app.get('/admin', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    const courses = (await readData('courses')) || [];
    const students = await prisma.user.findMany({ where: { role: 'student', deletedAt: null }, select: { id: true, name: true, role: true, stage: true, grade: true, subscriptionStatus: true, lastLogin: true, createdAt: true, avatar: true, email: true, phone: true } });
    const announcements = (await readData('announcements')) || [];
    const subscriptions = (await readData('subscriptions')) || [];
    const reviews = (await readData('reviews')) || [];
    const payments = await readData('payments') || [];
    let analyticsOverview = null;
    try { analyticsOverview = await analytics.getAdminAnalytics(); } catch(e) {}
    res.render('admin/dashboard', { students, courses, announcements, subscriptions, reviews, payments, analyticsOverview, title: 'لوحة الإدارة - المُميز' });
  } catch(e) {
    console.error('Admin dashboard error:', e);
    res.status(500).send('خطأ في تحميل لوحة التحكم: ');
  }
});

app.get('/admin/students', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    const students = await prisma.user.findMany({ where: { role: 'student', deletedAt: null } });
    if (storageConfig.isR2Enabled()) {
      var storage = getStorageService();
      for (var si = 0; si < students.length; si++) {
        if (students[si].avatar && !students[si].avatar.startsWith('data:')) {
          try { students[si].avatar = await storage.createPublicUrl(students[si].avatar); } catch (_) {}
        }
      }
    }
    res.render('admin/students', { students, title: 'الطلاب - الإدارة' });
  } catch(e) {
    res.render('admin/students', { students: [], title: 'الطلاب - الإدارة' });
  }
});

app.get('/admin/courses', requireAdmin, async (req, res) => {
  try {
    const allCourses = await readData('courses');
    const stage = req.query.stage || '';
    const grade = req.query.grade || '';
    var courses = allCourses;
    if (stage === 'all') {
      // show all courses, no filter
    } else if (stage) courses = courses.filter(function(c) { return c.stage === stage; });
    if (grade) courses = courses.filter(function(c) { return c.grade === grade; });
    const allNotes = await readData('notes') || [];
    const allReviews = await readData('reviews') || [];
    const allQuestionBanks = await readData('questionBanks') || [];
    res.render('admin/courses', { courses, allCourses, stage, grade, allNotes, allReviews, allQuestionBanks, title: 'المحاضرات - الإدارة' });
  } catch(e) {
    console.error('Admin courses error:', e);
    res.status(500).send('خطأ في تحميل صفحة المحاضرات: ');
  }
});

app.get('/admin/subscriptions', requireAdmin, async (req, res) => {
  try {
    const subscriptions = await readData('subscriptions') || [];
    const courses = await readData('courses') || [];
    res.render('admin/subscriptions', { subscriptions, courses, title: 'الاشتراكات - الإدارة' });
  } catch (e) {
    console.error('Admin subscriptions error:', e);
    res.status(500).send('خطأ في تحميل الاشتراكات');
  }
});

app.get('/admin/payments', requireAdmin, async (req, res) => {
  try {
    const payments = await readData('payments') || [];
    if (storageConfig.isR2Enabled()) {
      const storage = getStorageService();
      for (const p of payments) {
        if (p.receiptImage && !p.receiptImage.startsWith('data:')) {
          try { p.receiptImage = await storage.createSignedUrl(p.receiptImage, 300); } catch (_) {}
        }
      }
    }
    var totalRevenue = payments.filter(p => p.status === 'approved').reduce(function(sum, p) { return sum + (Number(p.amount) || 0); }, 0);
    res.render('admin/payments', { payments, totalRevenue, title: 'المدفوعات - الإدارة' });
  } catch(e) {
    console.error('Admin payments error:', e);
    res.status(500).send('خطأ في تحميل المدفوعات: ');
  }
});

app.get('/admin/settings', requireAdmin, async (req, res) => {
  var settings = await readData('settings') || {};
  res.render('admin/settings', {
    currentSemester: settings.currentSemester || 'all',
    vodafoneCash: settings.vodafoneCash || process.env.VODAFONE_CASH || '01000000000',
    instaPay: settings.instaPay || process.env.INSTAPAY || 'example@instapay.com',
    contactPhone: settings.contactPhone || '0100 000 0000',
    contactEmail: settings.contactEmail || 'info@lughati.com',
    contactAddress: settings.contactAddress || 'القاهرة، مصر',
    contactWhatsapp: settings.contactWhatsapp || '0100 000 0000',
    announcementsEnabled: settings.announcementsEnabled !== false,
    referralDiscount: settings.referralDiscount != null ? settings.referralDiscount : 25,
    title: 'الإعدادات - الإدارة'
  });
});

// POST /api/admin/theme — Save platform theme (colors + button shape)
app.post('/api/admin/theme', requireDevAccess, async (req, res) => {
  try {
    var accent = (req.body.accent || '').trim();
    var btnShape = (req.body.btnShape || 'rounded').trim();
    var fontName = (req.body.fontName || '').trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(accent) && !/^#?[0-9a-fA-F]{3}$/.test(accent)) {
      return res.status(400).json({ error: 'يرجى إدخال لون صالح (مثال: #3B82F6)' });
    }
    if (accent[0] !== '#') accent = '#' + accent;
    if (!['square', 'rounded', 'circular'].includes(btnShape)) btnShape = 'rounded';
    var current = await readData('themeConfig') || {};
    var fontData = current.fontData || null;
    if (fontData) fontData.name = fontName;
    var light = req.body.light;
    var dark = req.body.dark;
    if (light && typeof light === 'object') {
      var lt = {};
      if (light.bg && /^#[0-9a-fA-F]{6}$/.test(light.bg)) lt.bg = light.bg;
      if (light.card && /^#[0-9a-fA-F]{6}$/.test(light.card)) lt.card = light.card;
      if (light.text && /^#[0-9a-fA-F]{6}$/.test(light.text)) lt.text = light.text;
      if (light.sidebarTextHover && /^#[0-9a-fA-F]{6}$/.test(light.sidebarTextHover)) lt.sidebarTextHover = light.sidebarTextHover;
      if (light.sidebarTextActive && /^#[0-9a-fA-F]{6}$/.test(light.sidebarTextActive)) lt.sidebarTextActive = light.sidebarTextActive;
      if (light.sidebarIconHover && /^#[0-9a-fA-F]{6}$/.test(light.sidebarIconHover)) lt.sidebarIconHover = light.sidebarIconHover;
      if (light.sidebarIconActive && /^#[0-9a-fA-F]{6}$/.test(light.sidebarIconActive)) lt.sidebarIconActive = light.sidebarIconActive;
      if (light.sidebarLogout && /^#[0-9a-fA-F]{6}$/.test(light.sidebarLogout)) lt.sidebarLogout = light.sidebarLogout;
      if (Object.keys(lt).length) current.light = lt;
    }
    if (dark && typeof dark === 'object') {
      var dk = {};
      if (dark.bg && /^#[0-9a-fA-F]{6}$/.test(dark.bg)) dk.bg = dark.bg;
      if (dark.card && /^#[0-9a-fA-F]{6}$/.test(dark.card)) dk.card = dark.card;
      if (dark.text && /^#[0-9a-fA-F]{6}$/.test(dark.text)) dk.text = dark.text;
      if (dark.sidebarTextHover && /^#[0-9a-fA-F]{6}$/.test(dark.sidebarTextHover)) dk.sidebarTextHover = dark.sidebarTextHover;
      if (dark.sidebarTextActive && /^#[0-9a-fA-F]{6}$/.test(dark.sidebarTextActive)) dk.sidebarTextActive = dark.sidebarTextActive;
      if (dark.sidebarIconHover && /^#[0-9a-fA-F]{6}$/.test(dark.sidebarIconHover)) dk.sidebarIconHover = dark.sidebarIconHover;
      if (dark.sidebarIconActive && /^#[0-9a-fA-F]{6}$/.test(dark.sidebarIconActive)) dk.sidebarIconActive = dark.sidebarIconActive;
      if (dark.sidebarLogout && /^#[0-9a-fA-F]{6}$/.test(dark.sidebarLogout)) dk.sidebarLogout = dark.sidebarLogout;
      if (Object.keys(dk).length) current.dark = dk;
    }
    var theme = { accent: accent, btnShape: btnShape, fontName: fontName, fontData: fontData, light: current.light, dark: current.dark, updatedAt: new Date().toISOString(), updatedBy: req.session.user ? (req.session.user.name || req.session.user.id) : 'admin' };
    await writeData('themeConfig', theme);
    await getThemeCss(true);
    res.json({ success: true, theme: theme });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// Font upload handler (separate from multer with broader MIME filtering)
var fontUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    var ext = (file.originalname || '').toLowerCase();
    if (ext.endsWith('.woff2') || ext.endsWith('.woff') || ext.endsWith('.ttf') || ext.endsWith('.otf')) return cb(null, true);
    cb(new Error('يُسمح فقط بملفات الخطوط (woff2, woff, ttf, otf)'));
  }
});

// POST /api/admin/upload-font — Upload a custom font file
app.post('/api/admin/upload-font', requireDevAccess, fontUpload.single('fontFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });
    var ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    var mime = ext === 'woff2' ? 'font/woff2' : ext === 'woff' ? 'font/woff' : ext === 'ttf' ? 'font/ttf' : 'font/otf';
    var cssFormat = ext === 'ttf' ? 'truetype' : ext === 'otf' ? 'opentype' : ext;
    var displayName = (req.body.fontName || '').trim() || req.file.originalname.replace(/\.[^.]+$/, '');
    var current = await readData('themeConfig') || {};
    current.fontName = displayName;
    var fontData = { name: displayName, format: cssFormat, mime: mime, ext: ext, fileName: req.file.originalname, size: req.file.buffer.length };
    if (storageConfig.isR2Enabled()) {
      if (current.fontData && current.fontData.r2 && current.fontData.data) {
        try { await getStorageService().delete(current.fontData.data); } catch (_) {}
      }
      var validation = validateUpload({ buffer: req.file.buffer, originalName: req.file.originalname, declaredMime: mime, type: 'font' });
      if (!validation.valid) return res.status(400).json({ error: validation.error });
      var storage = getStorageService();
      var safeName = displayName.replace(/\s+/g, '_').replace(/[^\w.\-]/g, '') || 'font';
      var objectKey = storage.generateObjectKey('fonts', safeName, 'font', req.file.originalname);
      await storage.upload({ key: objectKey, body: req.file.buffer, contentType: mime, visibility: 'public', metadata: { type: 'font', entityId: safeName, uploadedBy: req.session.user.id, uploadedAt: new Date().toISOString() } });
      fontData.data = objectKey;
      fontData.r2 = true;
    } else {
      fontData.data = req.file.buffer.toString('base64');
    }
    current.fontData = fontData;
    await writeData('themeConfig', current);
    await getThemeCss(true);
    res.json({ success: true, fontName: displayName, fileName: req.file.originalname });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// POST /api/admin/remove-font — Remove custom font, fall back to Google Fonts
app.post('/api/admin/remove-font', requireDevAccess, async (req, res) => {
  try {
    var current = await readData('themeConfig') || {};
    if (current.fontData && current.fontData.r2 && current.fontData.data && storageConfig.isR2Enabled()) {
      try { await getStorageService().delete(current.fontData.data); } catch (_) {}
    }
    delete current.fontData;
    await writeData('themeConfig', current);
    await getThemeCss(true);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

/* ===================== Zoom App Management (Admin) ===================== */

// Helper: call Vercel API to upsert an environment variable
async function vercelUpsertEnv(name, value) {
  if (!process.env.VERCEL_TOKEN) throw new Error('VERCEL_TOKEN غير مضبوط');
  var projectId = process.env.VERCEL_PROJECT_ID || 'prj_sv79LLQiLzy77WaEjqvGc75XVlcF';
  var teamId = process.env.VERCEL_TEAM_ID; // optional
  var base = 'https://api.vercel.com/v10/projects/' + projectId + '/env';
  var qs = teamId ? ('?teamId=' + teamId) : '';
  // 1) list existing
  var listRes = await new Promise(function(resolve, reject) {
    var req = https.request(base + qs, { method: 'GET', headers: { 'Authorization': 'Bearer ' + process.env.VERCEL_TOKEN } }, function(r) {
      var d = ''; r.on('data', function(c){ d += c; }); r.on('end', function(){ try { resolve(JSON.parse(d)); } catch(e){ reject(e); } });
    });
    req.on('error', reject); req.end();
  });
  var existing = (listRes.env || []).find(function(e) { return e.key === name; });
  var payload = JSON.stringify({ key: name, value: value, type: 'encrypted', target: ['production'] });
  if (existing) {
    var upd = await new Promise(function(resolve, reject) {
      var req = https.request(base + '/' + existing.id + qs, { method: 'PATCH', headers: { 'Authorization': 'Bearer ' + process.env.VERCEL_TOKEN, 'Content-Type': 'application/json' } }, function(r) {
        var d = ''; r.on('data', function(c){ d += c; }); r.on('end', function(){ try { resolve(JSON.parse(d)); } catch(e){ reject(e); } });
      });
      req.on('error', reject); req.write(payload); req.end();
    });
    return upd;
  }
  var created = await new Promise(function(resolve, reject) {
    var req = https.request(base + qs, { method: 'POST', headers: { 'Authorization': 'Bearer ' + process.env.VERCEL_TOKEN, 'Content-Type': 'application/json' } }, function(r) {
      var d = ''; r.on('data', function(c){ d += c; }); r.on('end', function(){ try { resolve(JSON.parse(d)); } catch(e){ reject(e); } });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
  return created;
}

app.post('/admin/zoom-app/reset', requireAdmin, async (req, res) => {
  try {
    // Try Vercel API first, fallback to current env vars
    var cid = '', csec = '', ruri = '';
    try {
      var projectId = process.env.VERCEL_PROJECT_ID || 'prj_sv79LLQiLzy77WaEjqvGc75XVlcF';
      var token = process.env.VERCEL_TOKEN || '';
      var envs = await new Promise(function(resolve, reject) {
        var d = ''; var qs = '?teamId=abdoulrahmanofficial-engs-projects';
        var req2 = https.get('https://api.vercel.com/v10/projects/' + projectId + '/env' + qs, { headers: { 'Authorization': 'Bearer ' + token } }, function(r) {
          r.on('data', function(c){ d += c; }); r.on('end', function(){ try { resolve(JSON.parse(d)); } catch(e){ reject(e); } });
        });
        req2.on('error', reject); req2.end();
      });
      var getVal = function(key) {
        var e = (envs.env || []).find(function(e2) { return e2.key === key; });
        return e ? e.value : '';
      };
      cid = getVal('ZOOM_CLIENT_ID');
      csec = getVal('ZOOM_CLIENT_SECRET');
      ruri = getVal('ZOOM_REDIRECT_URI');
    } catch(e) { console.error('Vercel API failed:', e.message); }
    // Fallback to known credentials
    if (!cid) cid = 'oYQXQYlnRVGCLjVdujSVg';
    if (!csec) csec = 'YY4P5GoLPPGKezUDixSSek1sGGKrNxtA';
    if (!ruri) ruri = 'https://almumayaz.online/auth/zoom/callback';
    await zoom.saveCredentials(cid, csec, ruri, cid, csec);
    res.redirect('/admin/zoom-app?saved=1');
  } catch (e) {
    res.status(500).send(safeErr(e, 'فشل إعادة التعيين'));
  }
});

app.get('/admin/zoom-app', requireAdmin, async (req, res) => {
  var creds = await zoom.getStoredCredentials();
  var cid = creds ? creds.clientId : (process.env.ZOOM_CLIENT_ID || '');
  var csec = creds ? creds.clientSecret : (process.env.ZOOM_CLIENT_SECRET || '');
  var ruri = creds ? creds.redirectUri : (process.env.ZOOM_REDIRECT_URI || '');
  var sk = creds ? creds.sdkKey : (process.env.ZOOM_SDK_KEY || '');
  var ssec = creds ? creds.sdkSecret : (process.env.ZOOM_SDK_SECRET || '');
  res.render('admin/zoom-app', {
    clientId: cid ? cid.substring(0, 6) + '…' : '',
    clientIdFull: cid,
    clientSecretFull: csec,
    clientSecretDisplay: csec ? csec.substring(0, 6) + '…' : '',
    redirectUri: ruri,
    sdkKeyFull: sk,
    sdkSecretFull: ssec,
    saved: req.query.saved === '1',
    title: 'إعدادات تطبيق Zoom - الإدارة'
  });
});

app.post('/admin/zoom-app', requireAdmin, async (req, res) => {
  try {
    var clientId = (req.body.clientId || '').trim();
    var clientSecret = (req.body.clientSecret || '').trim();
    var redirectUri = (req.body.redirectUri || '').trim() || 'https://almumayaz.online/auth/zoom/callback';
    var sdkKey = (req.body.sdkKey || '').trim();
    var sdkSecret = (req.body.sdkSecret || '').trim();
    if (!clientId || !clientSecret) return res.status(400).send('يرجى إدخال Client ID و Client Secret');
    await zoom.saveCredentials(clientId, clientSecret, redirectUri, sdkKey, sdkSecret);
    res.redirect('/admin/zoom-app?saved=1');
  } catch (e) {
    console.error('Zoom app save error:', e.message);
    res.status(500).send(safeErr(e, 'فشل الحفظ'));
  }
});

app.get('/admin/charge-codes', requireAdmin, async (req, res) => {
  var chargeCodes = await fbRead('chargeCodes');
  if (!chargeCodes) chargeCodes = [];
  if (!Array.isArray(chargeCodes)) chargeCodes = Object.keys(chargeCodes).map(function(k){chargeCodes[k]._key=k; return chargeCodes[k];});
  var now = new Date();
  chargeCodes.forEach(function(c) {
    c.currentUses = c.usedCount || 0;
    var exp = c.expiryDate && new Date(c.expiryDate) < now;
    c.status = exp ? 'expired' : (c.active !== false ? 'active' : 'pending');
  });
  res.render('admin/charge-codes', { chargeCodes, title: 'أكواد الشحن - الإدارة' });
});

app.get('/admin/announcements', requireAdmin, async (req, res) => {
  const announcements = await readData('announcements');
  res.render('admin/announcements', { announcements, title: 'الإعلانات - الإدارة' });
});

app.get('/admin/quotes', requireAdmin, async (req, res) => {
  const quotes = await readData('quotes');
  res.render('admin/quotes', { quotes, title: 'الجمل التحفيزية - الإدارة' });
});

app.get('/admin/send-notification', requireAdmin, (req, res) => {
  res.render('admin/send-notification', { title: 'إرسال إشعار - الإدارة' });
});

app.get('/admin/notifications', requireAdmin, async (req, res) => {
  try {
    const all = await readData('notifications') || [];
    const u = req.session.user;
    const dismissed = await readData('dismissed/' + u.id) || {};
    const list = all.filter(function(n) {
      if (n.target === 'admin') return true;
      if (n.source === 'chat') return true;
      return false;
    }).filter(function(n) { return !dismissed[n.id]; }).sort(function(a, b) { return new Date(b.sentAt || 0) - new Date(a.sentAt || 0); });
    res.render('admin/notifications', { notifications: list, title: 'مركز الإشعارات - الإدارة' });
  } catch (e) {
    res.render('admin/notifications', { notifications: [], title: 'مركز الإشعارات - الإدارة' });
  }
});

app.post('/admin/notifications/dismiss', requireAdmin, async (req, res) => {
  try {
    const id = req.body && req.body.id;
    if (!id) return res.status(400).json({ ok: false });
    const u = req.session.user;
    const dismissed = await readData('dismissed/' + u.id) || {};
    dismissed[id] = true;
    await writeData('dismissed/' + u.id, dismissed);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false }); }
});

app.get('/admin/live-sessions', requireAdmin, async (req, res) => {
  res.render('admin/live-sessions', { title: 'الحصص المباشرة - الإدارة' });
});

app.get('/admin/notes', requireAdmin, async (req, res) => {
  const notes = await readData('notes');
  res.render('admin/notes', { notes, title: 'المذكرات - الإدارة' });
});

app.get('/admin/reviews', requireAdmin, async (req, res) => {
  var allReviews = (await readData('reviews')) || [];
  var allCourses = (await readData('courses')) || [];
  var stage = req.query.stage || '';
  var grade = req.query.grade || '';
  var reviews = allReviews;
  if (stage) reviews = reviews.filter(function(r) { return r.stage === stage || r.stage === 'all' || !r.stage; });
  if (grade) reviews = reviews.filter(function(r) { return r.grade === grade || !r.grade; });
  res.render('admin/reviews', { reviews, allReviews, allCourses, stage, grade, title: 'المراجعات - الإدارة' });
});

app.get('/admin/chat', requireAdmin, (req, res) => {
  res.render('admin/chat-list', { title: 'تواصل مع الطلاب - الإدارة' });
});

app.get('/admin/homework-submissions', requireAdmin, async (req, res) => {
  try {
    const chats = await fbRead('homework-chats') || {};
    const users = await readData('users') || [];
    const userMap = {};
    users.forEach(u => { userMap[u.id] = u; });

    const submissions = Object.entries(chats).map(([studentId, chat]) => {
      const messages = (chat.messages || []).filter(m => m.sender === studentId);
      const student = userMap[studentId] || { name: 'غير معروف', email: '', stage: '', grade: '' };
      const lastMsg = messages[messages.length - 1];
      return {
        studentId,
        studentName: student.name,
        studentEmail: student.email,
        studentStage: student.stage,
        studentGrade: student.grade,
        messageCount: messages.length,
        lastMessage: lastMsg ? (lastMsg.text || (lastMsg.image ? '📷 صورة' : '📎 ملف')) : 'لا توجد رسائل',
        lastTime: lastMsg ? lastMsg.timestamp : null
      };
    }).filter(s => s.messageCount > 0).sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));

    res.render('admin/homework-submissions', { submissions, title: 'واجبات الطلاب - الإدارة' });
  } catch (e) {
    console.error('[homework-submissions] error:', e);
    res.render('admin/homework-submissions', { submissions: [], title: 'واجبات الطلاب - الإدارة' });
  }
});

app.get('/admin/homework-chat/:studentId', requireAdmin, async (req, res) => {
  const studentId = req.params.studentId;
  const chatId = 'homework-' + studentId;
  var prisma = getPrisma();
  const student = await prisma.user.findFirst({ where: { OR: [{ id: studentId }, { uid: studentId }], deletedAt: null }, select: { name: true } });
  res.render('admin/homework-chat', { chatId, studentName: student ? student.name : '', title: 'محادثة الواجب - الإدارة' });
});

app.get('/admin/sub-requests', requireAdmin, async (req, res) => {
  res.render('admin/sub-requests', { title: 'طلبات الاشتراك - الإدارة' });
});

app.get('/admin/chat/:studentId', requireAdmin, async (req, res) => {
  const chatId = 'student-' + req.params.studentId;
  const studentId = req.params.studentId;
  var prisma = getPrisma();
  const student = await prisma.user.findFirst({ where: { OR: [{ id: studentId }, { uid: studentId }], deletedAt: null }, select: { name: true } });
  res.render('admin/chat', { chatId, studentName: student ? student.name : '', title: 'محادثة طالب - الإدارة' });
});

/* ===================== ADMIN API: CHATS ===================== */

app.get('/api/admin/chats', requireAdmin, async (req, res) => {
  try {
    const allChats = await fbRead('chats');
    if (!allChats || typeof allChats !== 'object') return res.json({ success: true, chats: [] });
    var prisma = getPrisma();
    const allUsers = await prisma.user.findMany({ where: { deletedAt: null }, select: { id: true, uid: true, name: true } });
    const chats = [];
    Object.keys(allChats).forEach(function(chatId) {
      const chat = allChats[chatId];
      if (!chat || !chat.messages) return;
      // Show only per-student chats (student-XXXX), skip general/lughati/guest chats
      if (!chatId.startsWith('student-')) return;
      const msgKeys = Object.keys(chat.messages);
      const lastMsg = chat.messages[msgKeys[msgKeys.length - 1]];
      let unreadCount = 0;
      msgKeys.forEach(function(k) { if (chat.messages[k].senderId !== 'teacher' && !chat.messages[k].read) unreadCount++; });
      const studentId = chatId.startsWith('student-') ? chatId.replace('student-', '') : chatId;
      var studentName = '';
      if (lastMsg && lastMsg.senderId !== 'teacher') {
        studentName = lastMsg.senderName;
      } else {
        // Last message was from teacher — look up real student name from users
        var chatStudent = allUsers.find(function(u) { return u.id === studentId || u.uid === studentId; });
        studentName = chatStudent ? chatStudent.name : (lastMsg ? lastMsg.senderName : (chatId.startsWith('guest-') ? 'زائر' : studentId));
      }
      chats.push({
        id: chatId, studentId, name: studentName, initial: studentName.charAt(0),
        lastText: lastMsg ? (lastMsg.text || '(صورة)') : '',
        lastTime: lastMsg ? lastMsg.timestamp : null, unread: unreadCount
      });
    });
    chats.sort(function(a, b) { return (b.lastTime || 0) - (a.lastTime || 0); });
    res.json({ success: true, chats });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN API: COURSES ===================== */

app.post('/api/admin/courses', requireAdmin, async (req, res) => {
  try {
    const courses = await readData('courses');
    const { title, subtitle, description, icon, color, gradient, stage, grade, semester } = req.body;
    const newCourse = {
      id: Date.now().toString(),
      title: title || 'مادة جديدة',
      subtitle: subtitle || '',
      description: description || '',
      icon: icon || 'fa-book',
      color: color || '#A07200',
      gradient: gradient || 'linear-gradient(135deg, #A07200 0%, #D4A017 50%, #F6C453 100%)',
      stage: stage || 'all',
      grade: grade || '',
      semester: semester || 'all',
      sections: [],
      lessons: [],
      quiz: null
    };
    courses.push(newCourse);
    await writeData('courses', courses);
    sendFCMToRole('student', 'مادة جديدة تمت إضافتها 📚', 'تم إضافة مادة "' + (title || 'جديدة') + '" إلى المنصة. تفضل بزيارتها الآن!', '/courses');
    res.json({ success: true, course: newCourse });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.put('/api/admin/courses/:id', requireAdmin, async (req, res) => {
  try {
    const courses = await readData('courses');
    const idx = courses.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'المادة غير موجودة' });
    var allowedFields = ['title','subtitle','description','icon','color','gradient','image','grade','stage','price','guestVisible','active','order','semester','sections','lessons','quiz'];
    allowedFields.forEach(function(k) { if (req.body[k] !== undefined) courses[idx][k] = req.body[k]; });
    await writeData('courses', courses);
    res.json({ success: true, course: courses[idx] });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.delete('/api/admin/courses/:id', requireAdmin, async (req, res) => {
  try {
    const prisma = getPrisma();
    await prisma.course.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() }
    });
    // also soft-delete all lessons under this course
    await prisma.lesson.updateMany({
      where: { courseId: req.params.id, deletedAt: null },
      data: { deletedAt: new Date() }
    });
    cacheInvalidate('courses');
    res.json({ success: true });
  } catch (e) {
    console.error('[delete course]', e.message);
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN API: SECTIONS (TREE VIEW) ===================== */

app.post('/api/admin/courses/:id/sections', requireAdmin, async (req, res) => {
  try {
    const courses = await readData('courses');
    const course = courses.find(c => c.id === req.params.id);
    if (!course) return res.status(404).json({ error: 'المادة غير موجودة' });
    const { name } = req.body;
    const section = { id: 'sec-' + Date.now(), name: name || 'فرع جديد', lessons: [] };
    if (!course.sections) course.sections = [];
    course.sections.push(section);
    await writeData('courses', courses);
    res.json({ success: true, section });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.put('/api/admin/courses/:id/sections/:sectionId', requireAdmin, async (req, res) => {
  try {
    const courses = await readData('courses');
    const course = courses.find(c => c.id === req.params.id);
    if (!course) return res.status(404).json({ error: 'المادة غير موجودة' });
    const section = (course.sections || []).find(s => s.id === req.params.sectionId);
    if (!section) return res.status(404).json({ error: 'الفرع غير موجود' });
    const allowedFields = ['name'];
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) section[field] = req.body[field];
    }
    await writeData('courses', courses);
    res.json({ success: true, section });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.delete('/api/admin/courses/:id/sections/:sectionId', requireAdmin, async (req, res) => {
  try {
    const courses = await readData('courses');
    const course = courses.find(c => c.id === req.params.id);
    if (!course) return res.status(404).json({ error: 'المادة غير موجودة' });
    const idx = (course.sections || []).findIndex(s => s.id === req.params.sectionId);
    if (idx === -1) return res.status(404).json({ error: 'الفرع غير موجود' });
    course.sections.splice(idx, 1);
    await writeData('courses', courses);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN API: LESSONS ===================== */

app.post('/api/admin/courses/:id/lessons', requireAdmin, async (req, res) => {
  try {
    const courses = await readData('courses');
    const course = courses.find(c => c.id === req.params.id);
    if (!course) return res.status(404).json({ error: 'المادة غير موجودة' });
    const { title, description, videos, pdfFiles, duration, order, isFree, guestVisible, published, sectionId, quiz } = req.body;
    const newLesson = {
      id: Date.now().toString(),
      title: title || 'محاضرة جديدة',
      description: description || '',
      videos: videos || [],
      pdfFiles: pdfFiles || [],
      duration: duration || '00:00',
      order: order !== undefined ? order : 0,
      isFree: isFree || false,
      guestVisible: guestVisible || false,
      published: published !== undefined ? published : true,
      sectionId: sectionId || '',
      quiz: quiz || null
    };
    if (!course.lessons) course.lessons = [];
    course.lessons.push(newLesson);
    if (sectionId && course.sections) {
      const sec = course.sections.find(s => s.id === sectionId);
      if (sec) { if (!sec.lessons) sec.lessons = []; if (sec.lessons.indexOf(newLesson.id) === -1) sec.lessons.push(newLesson.id); }
    }
    await writeData('courses', courses);
    sendFCMToRole('student', 'محاضرة جديدة تمت إضافتها 🎬', 'تم إضافة محاضرة "' + (title || 'جديدة') + '" في مادة ' + (course.title || '') + '.', '/student/course/' + course.id);
    res.json({ success: true, lesson: newLesson });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.put('/api/admin/courses/:id/lessons/:lessonId', requireAdmin, async (req, res) => {
  try {
    const courses = await readData('courses');
    const course = courses.find(c => c.id === req.params.id);
    if (!course) return res.status(404).json({ error: 'المادة غير موجودة' });
    const lesson = (course.lessons||[]).find(l => l.id === req.params.lessonId);
    if (!lesson) return res.status(404).json({ error: 'المحاضرة غير موجودة' });
    const { title, description, videos, pdfFiles, duration, order, isFree, guestVisible, published, sectionId, quiz } = req.body;
    if (title !== undefined) lesson.title = title;
    if (description !== undefined) lesson.description = description;
    if (videos !== undefined) lesson.videos = videos;
    if (pdfFiles !== undefined) lesson.pdfFiles = pdfFiles;
    if (duration !== undefined) lesson.duration = duration;
    if (order !== undefined) lesson.order = order;
    if (isFree !== undefined) lesson.isFree = isFree;
    if (guestVisible !== undefined) lesson.guestVisible = guestVisible;
    if (published !== undefined) lesson.published = published;
    if (quiz !== undefined) lesson.quiz = quiz;
    if (sectionId !== undefined) {
      (course.sections || []).forEach(s => { if (s.lessons) s.lessons = s.lessons.filter(id => id !== lesson.id); });
      lesson.sectionId = sectionId;
      if (sectionId && course.sections) {
        const sec = course.sections.find(s => s.id === sectionId);
        if (sec) { if (!sec.lessons) sec.lessons = []; if (sec.lessons.indexOf(lesson.id) === -1) sec.lessons.push(lesson.id); }
      }
    }
    await writeData('courses', courses);
    res.json({ success: true, lesson });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN: FORCE SEED MIGRATION ===================== */

app.get('/api/admin/diagnose', requireAdmin, async (req, res) => {
  try {
    const { fbDb } = require('./prisma-bridge');
    if (!fbDb) return res.json({ firebase: 'غير متاح' });
    const snap = await fbDb.ref('courses').once('value');
    const val = snap.val();
    const info = {
      type: typeof val,
      isArray: Array.isArray(val),
      isNull: val === null,
      keys: val && typeof val === 'object' && !Array.isArray(val) ? Object.keys(val).slice(0, 5) : [],
      sampleKeys: val && typeof val === 'object' ? Object.keys(val).slice(0, 3) : [],
      length: Array.isArray(val) ? val.length : (val && typeof val === 'object' ? Object.keys(val).length : 'N/A')
    };
    if (Array.isArray(val)) {
      info.firstId = val[0]?.id;
      info.firstTitle = val[0]?.title;
      info.firstHasLessons = Array.isArray(val[0]?.lessons);
      info.lessonCount = val[0]?.lessons?.length;
    }
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.delete('/api/admin/courses/:id/lessons/:lessonId', requireAdmin, async (req, res) => {
  try {
    const courses = await readData('courses');
    const course = courses.find(c => c.id === req.params.id);
    if (!course) return res.status(404).json({ error: 'المادة غير موجودة' });
    const idx = (course.lessons||[]).findIndex(l => l.id === req.params.lessonId);
    if (idx === -1) return res.status(404).json({ error: 'المحاضرة غير موجودة' });
    course.lessons.splice(idx, 1);
    await writeData('courses', courses);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN API: QUIZ ===================== */

app.put('/api/admin/courses/:id/quiz', requireAdmin, async (req, res) => {
  try {
    const courses = await readData('courses');
    const course = courses.find(c => c.id === req.params.id);
    if (!course) return res.status(404).json({ error: 'المادة غير موجودة' });
    const { title, questions, timerMinutes, timeSettings } = req.body;
    course.quiz = {
      id: course.quiz ? course.quiz.id : 'q' + Date.now(),
      title: title || (course.quiz ? course.quiz.title : 'اختبار شامل'),
      questions: questions || [],
      timerMinutes: timerMinutes || null,
      timeSettings: timeSettings || null
    };
    await writeData('courses', courses);
    res.json({ success: true, quiz: course.quiz });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.delete('/api/admin/courses/:id/quiz', requireAdmin, async (req, res) => {
  try {
    const courses = await readData('courses');
    const course = courses.find(c => c.id === req.params.id);
    if (!course) return res.status(404).json({ error: 'المادة غير موجودة' });
    course.quiz = null;
    await writeData('courses', courses);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN API: NOTES (مذكرات) ===================== */

app.post('/api/admin/notes', requireAdmin, async (req, res) => {
  try {
    const notes = await readData('notes');
    const { title, description, fileUrl, filePath, stage, grade } = req.body;
    const newNote = {
      id: 'note-' + Date.now(),
      title: title || 'مذكرة جديدة',
      description: description || '',
      fileUrl: fileUrl || '',
      filePath: filePath || '',
      stage: stage || '',
      grade: grade || '',
      createdAt: new Date().toISOString()
    };
    notes.push(newNote);
    await writeData('notes', notes);
    res.json({ success: true, note: newNote });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.put('/api/admin/notes/:id', requireAdmin, async (req, res) => {
  try {
    const notes = await readData('notes');
    const idx = notes.findIndex(n => n.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'المذكرة غير موجودة' });
    const noteAllowed = ['title', 'description', 'filePath', 'stage', 'grade', 'type'];
    for (const field of noteAllowed) {
      if (req.body[field] !== undefined) notes[idx][field] = req.body[field];
    }
    await writeData('notes', notes);
    res.json({ success: true, note: notes[idx] });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.delete('/api/admin/notes/:id', requireAdmin, async (req, res) => {
  try {
    const notes = await readData('notes');
    const idx = notes.findIndex(n => n.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'المذكرة غير موجودة' });
    const note = notes[idx];
    if (note.filePath && storageConfig.isR2Enabled()) {
      try { await getStorageService().delete(note.filePath); } catch (_) {}
    }
    notes.splice(idx, 1);
    await writeData('notes', notes);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN: Comprehensive Exam ===================== */
app.get('/api/admin/comprehensive-exam', requireAdmin, async (req, res) => {
  try {
    const exam = await readData('comprehensiveExam');
    res.json({ success: true, exam: exam || null });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية' });
  }
});

app.delete('/api/admin/comprehensive-exam', requireAdmin, async (req, res) => {
  try {
    const exam = await readData('comprehensiveExam');
    if (exam && exam.filePath && storageConfig.isR2Enabled()) {
      try { await getStorageService().delete(exam.filePath); } catch (_) {}
    }
    await writeData('comprehensiveExam', null);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية' });
  }
});

app.post('/api/admin/comprehensive-exam/toggle', requireAdmin, async (req, res) => {
  try {
    const { enabled } = req.body;
    const exam = await readData('comprehensiveExam');
    if (!exam) return res.status(404).json({ error: 'الاختبار غير موجود' });
    exam.enabled = enabled !== false;
    await writeData('comprehensiveExam', exam);
    res.json({ success: true, enabled: exam.enabled });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية' });
  }
});

/* ===================== ADMIN API: QUESTION BANKS (بنوك الأسئلة) ===================== */

app.post('/api/admin/question-banks', requireAdmin, async (req, res) => {
  try {
    const banks = (await readData('questionBanks')) || [];
    const { courseId, title, description, timerMinutes, timeSettings, order, questions } = req.body;
    var courses = await readData('courses');
    var course = courses.find(function(c) { return c.id === courseId; });
    const newBank = {
      id: 'qb-' + Date.now(),
      courseId: courseId || '',
      title: title || 'بنك أسئلة جديد',
      description: description || '',
      timerMinutes: timerMinutes || null,
      timeSettings: timeSettings || null,
      order: order || 0,
      questions: questions || [],
      createdAt: new Date().toISOString()
    };
    banks.push(newBank);
    await writeData('questionBanks', banks);
    res.json({ success: true, bank: newBank });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.put('/api/admin/question-banks/:id', requireAdmin, async (req, res) => {
  try {
    const banks = (await readData('questionBanks')) || [];
    const idx = banks.findIndex(b => b.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'بنك الأسئلة غير موجود' });
    const bankAllowed = ['title', 'courseId', 'questions', 'description', 'timerMinutes', 'timeSettings', 'order'];
    for (const field of bankAllowed) {
      if (req.body[field] !== undefined) banks[idx][field] = req.body[field];
    }
    await writeData('questionBanks', banks);
    res.json({ success: true, bank: banks[idx] });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.delete('/api/admin/question-banks/:id', requireAdmin, async (req, res) => {
  try {
    const banks = (await readData('questionBanks')) || [];
    const idx = banks.findIndex(b => b.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'بنك الأسئلة غير موجود' });
    banks.splice(idx, 1);
    await writeData('questionBanks', banks);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN API: SUBSCRIPTIONS ===================== */

app.post('/api/admin/subscriptions', requireAdmin, async (req, res) => {
  try {
    const subscriptions = await readData('subscriptions');
    const { name, price, currency, period, features, popular, stage, durationDays, allowedLessons } = req.body;
    const newSub = {
      id: Date.now().toString(),
      name: name || 'باقة جديدة',
      price: price || '0',
      currency: currency || 'جنيه',
      period: period || 'شهرياً',
      features: features || [],
      popular: popular || false,
      stage: stage || '',
      durationDays: parseInt(durationDays) || 30
    };
    if (allowedLessons !== undefined) newSub.allowedLessons = allowedLessons;
    subscriptions.push(newSub);
    await writeData('subscriptions', subscriptions);
    res.json({ success: true, subscription: newSub });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.put('/api/admin/subscriptions/:id', requireAdmin, async (req, res) => {
  try {
    const subscriptions = await readData('subscriptions');
    const idx = subscriptions.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الباقة غير موجودة' });
    const allowed = ['name','price','currency','period','features','popular','stage','durationDays','allowedLessons'];
    for (const field of allowed) {
      if (req.body[field] !== undefined) subscriptions[idx][field] = req.body[field];
    }
    if (!Array.isArray(subscriptions[idx].features)) subscriptions[idx].features = [];
    subscriptions[idx].popular = !!subscriptions[idx].popular;
    subscriptions[idx].price = String(subscriptions[idx].price || '0');
    await writeData('subscriptions', subscriptions);
    res.json({ success: true, subscription: subscriptions[idx] });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.delete('/api/admin/subscriptions/:id', requireAdmin, async (req, res) => {
  try {
    const subscriptions = await readData('subscriptions');
    const idx = subscriptions.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الباقة غير موجودة' });
    subscriptions.splice(idx, 1);
    await writeData('subscriptions', subscriptions);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN API: SETTINGS ===================== */

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    var settings = await readData('settings') || {};
    var allowedFields = ['vodafoneCash','instaPay','contactPhone','contactEmail','contactAddress','contactWhatsapp','referralDiscount','currentSemester','announcementsEnabled'];
    allowedFields.forEach(function(k) { if (req.body[k] !== undefined) settings[k] = req.body[k]; });
    await writeData('settings', settings);
    res.json({ success: true, settings });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN API: ANNOUNCEMENTS ===================== */

app.post('/api/admin/announcements', requireAdmin, async (req, res) => {
  try {
    const announcements = await readData('announcements');
    const { title, content, important, sendPush } = req.body;
    const newAnn = {
      id: Date.now().toString(),
      title: title || 'إعلان جديد',
      content: content || '',
      date: new Date().toISOString().split('T')[0],
      important: important || false
    };
    announcements.push(newAnn);
    await writeData('announcements', announcements);
    if (sendPush) {
      sendFCMToRole('student', title || 'إعلان جديد من المُميز 📢', content || '', '/');
    }
    res.json({ success: true, announcement: newAnn });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.put('/api/admin/announcements/:id', requireAdmin, async (req, res) => {
  try {
    const announcements = await readData('announcements');
    const idx = announcements.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الإعلان غير موجود' });
    const announcementAllowed = ['title', 'content', 'active', 'important'];
    for (const field of announcementAllowed) {
      if (req.body[field] !== undefined) announcements[idx][field] = req.body[field];
    }
    await writeData('announcements', announcements);
    res.json({ success: true, announcement: announcements[idx] });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.delete('/api/admin/announcements/:id', requireAdmin, async (req, res) => {
  try {
    const announcements = await readData('announcements');
    const idx = announcements.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الإعلان غير موجود' });
    announcements.splice(idx, 1);
    await writeData('announcements', announcements);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN API: QUOTES ===================== */

app.get('/api/admin/quotes', requireAdmin, async (req, res) => {
  const quotes = await readData('quotes');
  res.json(quotes);
});

app.post('/api/admin/quotes', requireAdmin, async (req, res) => {
  try {
    const quotes = await readData('quotes');
    const quote = {
      id: 'quote-' + Date.now(),
      text: req.body.text,
      author: req.body.author || 'الأستاذ محمد عفيفي'
    };
    quotes.push(quote);
    await writeData('quotes', quotes);
    res.json({ success: true, quote });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.put('/api/admin/quotes/:id', requireAdmin, async (req, res) => {
  try {
    const quotes = await readData('quotes');
    const idx = quotes.findIndex(q => q.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الجملة غير موجودة' });
    quotes[idx].text = req.body.text || quotes[idx].text;
    quotes[idx].author = req.body.author || quotes[idx].author;
    await writeData('quotes', quotes);
    res.json({ success: true, quote: quotes[idx] });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.delete('/api/admin/quotes/:id', requireAdmin, async (req, res) => {
  try {
    const quotes = await readData('quotes');
    const idx = quotes.findIndex(q => q.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الجملة غير موجودة' });
    quotes.splice(idx, 1);
    await writeData('quotes', quotes);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== STUDENT API: QUOTE ===================== */

app.get('/api/student/quote', requireStudentOrGuest, async (req, res) => {
  const quotes = await readData('quotes');
  if (!quotes || quotes.length === 0) return res.json({ text: 'النجاح يبدأ بخطوة، وأنت على الطريق الصحيح', author: 'المُميز' });
  const q = quotes[Math.floor(Math.random() * quotes.length)];
  res.json(q);
});

/* ===================== ADMIN API: STUDENTS ===================== */

app.put('/api/admin/students/:id', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    var allowedFields = ['name','email','phone','stage','grade','governorate','subscriptionStatus','subscriptionEnd','notes'];
    var data = {};
    allowedFields.forEach(function(k) { if (req.body[k] !== undefined) data[k] = req.body[k]; });
    if (data.subscriptionEnd && typeof data.subscriptionEnd === 'string') data.subscriptionEnd = new Date(data.subscriptionEnd);
    var student = await prisma.user.update({ where: { id: req.params.id }, data });
    res.json({ success: true, student });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.delete('/api/admin/students/:id', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    var student = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, parentId: true, name: true } });
    if (!student) return res.status(404).json({ error: 'الطالب غير موجود' });

    // 1. Delete from Firebase Authentication
    try {
      await admin.auth().deleteUser(student.id);
      console.log('[delete] Firebase Auth user removed:', student.id);
    } catch (e) {
      if (e.code !== 'auth/user-not-found') console.error('[delete] Firebase Auth delete error:', e.message);
    }

    // 2. Delete chat from Firebase RTDB
    try {
      if (admin && admin.database) {
        await admin.database().ref('chats/student-' + student.id).remove();
      }
    } catch (e) { /* ignore */ }

    // 3. Remove from parent's childrenIds JSON
    if (student.parentId) {
      try {
        var parent = await prisma.user.findUnique({ where: { id: student.parentId }, select: { childrenIds: true, parentOf: true } });
        if (parent) {
          var childrenIds = parent.childrenIds || [];
          var parentOf = parent.parentOf || [];
          if (Array.isArray(childrenIds)) childrenIds = childrenIds.filter(function(cid) { return cid !== student.id; });
          if (Array.isArray(parentOf)) parentOf = parentOf.filter(function(n) { return n !== student.name; });
          await prisma.user.update({ where: { id: student.parentId }, data: { childrenIds: childrenIds, parentOf: parentOf } });
        }
      } catch (e) { console.error('[delete] parent cleanup error:', e.message); }
    }

    // 4. Soft-delete user
    await prisma.user.update({ where: { id: student.id }, data: { deletedAt: new Date(), deletedBy: req.session.user.id } });

    res.json({ success: true });
  } catch (e) {
    console.error('[delete] student error:', e.message);
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN API: STUDENT SUBSCRIPTION ===================== */

app.put('/api/admin/students/:id/subscription', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    var student = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, subscriptionEnd: true } });
    if (!student) return res.status(404).json({ error: 'الطالب غير موجود' });
    const { action, durationDays, stage, planName, period } = req.body;
    var now = new Date();
    var data = {};

    switch (action) {
      case 'activate':
        data.subscriptionStatus = 'active';
        data.subscriptionStart = now;
        data.subscriptionEnd = new Date(Date.now() + (durationDays || 30) * 24 * 60 * 60 * 1000);
        if (stage) data.subscribedStage = stage;
        if (planName) data.planName = planName;
        if (period) data.planPeriod = period;
        break;
      case 'deactivate':
        data.subscriptionStatus = 'inactive';
        data.planName = '';
        data.planPeriod = '';
        break;
      case 'extend':
        if (student.subscriptionEnd) {
          var end = new Date(student.subscriptionEnd);
          end.setDate(end.getDate() + (durationDays || 30));
          data.subscriptionEnd = end;
        } else {
          data.subscriptionEnd = new Date(Date.now() + (durationDays || 30) * 24 * 60 * 60 * 1000);
        }
        users[idx].subscriptionStatus = 'active';
        break;
      case 'cancel':
        users[idx].subscriptionStatus = 'cancelled';
        break;
      case 'stop':
        users[idx].subscriptionStatus = 'stopped';
        break;
    }

    // Update student record
    var updated = await prisma.user.update({ where: { id: req.params.id }, data });
    // Send push notification to student
    if (action === 'activate' || action === 'extend') {
      sendFCM(req.params.id, 'تم تفعيل اشتراكك 🎉', 'مرحباً ' + (updated.name || '') + '! تم تفعيل اشتراكك في منصة المُميز.', '/student/subscription');
    } else if (action === 'cancel' || action === 'stop') {
      sendFCM(req.params.id, 'تم إيقاف اشتراكك', 'عذراً ' + (updated.name || '') + '، تم إيقاف اشتراكك في منصة المُميز.', '/student/subscription');
    } else if (action === 'deactivate') {
      sendFCM(req.params.id, 'تم إلغاء تنشيط اشتراكك', 'عذراً ' + (updated.name || '') + '، تم إلغاء تنشيط اشتراكك.', '/student/subscription');
    }
    res.json({ success: true, student: updated });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN API: PAYMENTS ===================== */

app.put('/api/admin/payments/:id', requireAdmin, async (req, res) => {
  try {
    const payments = await readData('payments') || [];
    const idx = payments.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الدفعة غير موجودة' });
    const { status, rejectReason } = req.body;
    payments[idx].status = status;
    payments[idx].rejectReason = rejectReason || '';

    // Save payment record FIRST, then activate subscription
    await writeData('payments', payments);

    if (status === 'approved') {
      var prisma = getPrisma();
      await prisma.user.update({ where: { id: payments[idx].userId }, data: { subscriptionStatus: 'active', subscriptionStart: new Date(), subscriptionEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
      sendFCM(payments[idx].userId, 'تم تأكيد الدفعة 💳', 'مرحباً! تم تأكيد دفعتك وتفعيل اشتراكك في منصة المُميز. يمكنك الآن مشاهدة جميع المحاضرات.', '/student/subscription');
    }

    res.json({ success: true, payment: payments[idx] });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN API: CHARGE CODES ===================== */

app.post('/api/admin/charge-codes', requireAdmin, async (req, res) => {
  try {
    const chargeCodes = await fbRead('chargeCodes') || [];
    const chargeArr = Array.isArray(chargeCodes) ? chargeCodes : Object.keys(chargeCodes).map(function(k){chargeCodes[k]._key=k; return chargeCodes[k];});
    const { code, duration, expiryDays, subscriptionType, value, price, maxUses, name } = req.body;
    const days = duration || expiryDays || 365;
    const newCode = {
      id: Date.now().toString(),
      code: code || 'CODE-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
      expiryDate: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
      subscriptionType: subscriptionType || 'monthly',
      name: name || '',
      price: value || price || '0',
      maxUses: maxUses || 1,
      usedCount: 0,
      usedBy: [],
      active: true
    };
    chargeArr.push(newCode);
    await fbSet('chargeCodes', chargeArr);
    res.json({ success: true, code: newCode });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.post('/api/student/redeem-code', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== 'string') return res.status(400).json({ error: 'الكود غير صالح' });

    // Atomic RTDB transaction — prevents TOCTOU race on chargeCodes
    const { transactionData } = require('./prisma-bridge');
    var codeResult = null;
    await transactionData('chargeCodes', function(current) {
      var chargeArr = [];
      if (current) {
        if (Array.isArray(current)) chargeArr = current;
        else chargeArr = Object.keys(current).map(function(k){current[k]._key=k; return current[k];});
      }
      var cd = chargeArr.find(function(c) { return c.code === code && c.active !== false; });
      if (!cd) return current; // unchanged — will be caught below
      if (new Date(cd.expiryDate) < new Date()) return current;
      if (cd.usedCount >= cd.maxUses) return current;
      if ((cd.usedBy || []).includes(req.session.user.id)) return current;
      cd.usedCount = (cd.usedCount || 0) + 1;
      if (!cd.usedBy) cd.usedBy = [];
      cd.usedBy.push(req.session.user.id);
      codeResult = cd;
      return Array.isArray(current) ? chargeArr : chargeArr.reduce(function(acc, item) { var k=item._key||item.code; delete item._key; acc[k]=item; return acc; }, {});
    });
    if (!codeResult) {
      var chargeCodes = await fbRead('chargeCodes');
      var chargeArr2 = [];
      if (chargeCodes) {
        if (Array.isArray(chargeCodes)) chargeArr2 = chargeCodes;
        else chargeArr2 = Object.keys(chargeCodes).map(function(k){chargeCodes[k]._key=k; return chargeCodes[k];});
      }
      var cd2 = chargeArr2.find(function(c) { return c.code === code && c.active !== false; });
      if (!cd2) return res.status(404).json({ error: 'الكود غير صالح' });
      if (new Date(cd2.expiryDate) < new Date()) return res.status(400).json({ error: 'انتهت صلاحية الكود' });
      if (cd2.usedCount >= cd2.maxUses) return res.status(400).json({ error: 'تم استخدام الكود بأقصى عدد مرات' });
      if ((cd2.usedBy || []).includes(req.session.user.id)) return res.status(400).json({ error: 'لقد استخدمت هذا الكود من قبل' });
      return res.status(409).json({ error: 'الكود قيد الاستخدام من قبل مستخدم آخر' });
    }

    // Map subscription type to duration
    var durationMap = { monthly: 30, term: 180, yearly: 365 };
    var subType = codeResult.subscriptionType || 'monthly';
    var durationDays = durationMap[subType] || 30;
    var periodWord = { 'monthly': 'شهرياً', 'term': 'ترمياً', 'yearly': 'سنوياً' }[subType] || subType || '';

    var prisma = getPrisma();
    await prisma.$transaction([
      prisma.user.update({ where: { id: req.session.user.id }, data: { subscriptionStatus: 'active', subscriptionStart: new Date(), subscriptionEnd: new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000), planName: codeResult.name || '', planPeriod: periodWord } })
    ]);
    // Refresh session
    var updatedUser = await prisma.user.findUnique({ where: { id: req.session.user.id } });
    if (updatedUser) req.session.user = sessionUser(updatedUser);

    res.json({ success: true, message: 'تم تفعيل الاشتراك بنجاح' });
  } catch (e) {
    console.error('[redeem-code] error:', e.message);
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.put('/api/admin/charge-codes/:id', requireAdmin, async (req, res) => {
  try {
    var chargeCodes = await fbRead('chargeCodes');
    var chargeArr = Array.isArray(chargeCodes) ? chargeCodes : (chargeCodes ? Object.keys(chargeCodes).map(function(k){chargeCodes[k]._key=k; return chargeCodes[k];}) : []);
    const idx = chargeArr.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الكود غير موجود' });
    var allowedFields = ['expiresAt','maxUses','active','notes'];
    allowedFields.forEach(function(k) { if (req.body[k] !== undefined) chargeArr[idx][k] = req.body[k]; });
    await fbSet('chargeCodes', chargeArr);
    res.json({ success: true, code: chargeArr[idx] });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.delete('/api/admin/charge-codes/:id', requireAdmin, async (req, res) => {
  try {
    var chargeCodes = await fbRead('chargeCodes');
    var chargeArr = Array.isArray(chargeCodes) ? chargeCodes : (chargeCodes ? Object.keys(chargeCodes).map(function(k){chargeCodes[k]._key=k; return chargeCodes[k];}) : []);
    const idx = chargeArr.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الكود غير موجود' });
    chargeArr.splice(idx, 1);
    await fbSet('chargeCodes', chargeArr);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN API: REVIEWS ===================== */

app.post('/api/admin/reviews', requireAdmin, async (req, res) => {
  try {
    const reviews = (await readData('reviews')) || [];
    const { title, course, courseId, color, icon, desc, videoUrl, pdfUrl, videos, pdfFiles, stage, grade, order, isFree, accessCode } = req.body;
    const newReview = {
      id: Date.now().toString(),
      title: title || 'مراجعة جديدة',
      course: course || '',
      courseId: courseId || '',
      color: color || '#A07200',
      icon: icon || 'fa-book-open',
      date: new Date().toISOString(),
      desc: desc || '',
      videos: videos || (videoUrl ? [{ title: 'فيديو', url: videoUrl }] : []),
      pdfFiles: pdfFiles || (pdfUrl ? [{ title: 'ملف', url: pdfUrl }] : []),
      stage: stage || 'all',
      grade: grade || '',
      order: order !== undefined ? Number(order) : 0,
      isFree: !!isFree,
      accessCode: req.body.accessCode || ''
    };
    reviews.push(newReview);
    await writeData('reviews', reviews);
    sendFCMToRole('student', 'مراجعة جديدة تمت إضافتها 📝', 'تم إضافة مراجعة "' + (title || 'جديدة') + '". تفضل بمراجعتها الآن!', '/student/reviews');
    res.json({ success: true, review: newReview });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.put('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  try {
    const reviews = (await readData('reviews')) || [];
    const idx = reviews.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'المراجعة غير موجودة' });
    const reviewAllowed = ['title', 'desc', 'courseId', 'stage', 'grade', 'icon', 'color', 'order', 'isFree', 'accessCode', 'videos', 'pdfFiles'];
    for (const field of reviewAllowed) {
      if (req.body[field] !== undefined) reviews[idx][field] = req.body[field];
    }
    await writeData('reviews', reviews);
    res.json({ success: true, review: reviews[idx] });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.put('/api/admin/reviews/:id/quiz', requireAdmin, async (req, res) => {
  try {
    const reviews = (await readData('reviews')) || [];
    const review = reviews.find(r => r.id === req.params.id);
    if (!review) return res.status(404).json({ error: 'المراجعة غير موجودة' });
    const { title, questions, timerMinutes } = req.body;
    review.quiz = {
      id: review.quiz ? review.quiz.id : 'rq' + Date.now(),
      title: title || 'اختبار المراجعة',
      questions: questions || [],
      timerMinutes: timerMinutes || null
    };
    await writeData('reviews', reviews);
    res.json({ success: true, quiz: review.quiz });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.delete('/api/admin/reviews/:id/quiz', requireAdmin, async (req, res) => {
  try {
    const reviews = (await readData('reviews')) || [];
    const review = reviews.find(r => r.id === req.params.id);
    if (!review) return res.status(404).json({ error: 'المراجعة غير موجودة' });
    review.quiz = null;
    await writeData('reviews', reviews);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.delete('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  try {
    const reviews = (await readData('reviews')) || [];
    const idx = reviews.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'المراجعة غير موجودة' });
    reviews.splice(idx, 1);
    await writeData('reviews', reviews);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== NOTIFICATIONS API ===================== */

app.post('/api/fcm/verify', requireAuth, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({ where: { id: req.session.user.id }, select: { fcmToken: true } });
    const stored = (user && user.fcmToken) || '';
    res.json({
      matches: !!fcmToken && fcmToken === stored,
      storedLen: stored.length,
      browserLen: fcmToken ? fcmToken.length : 0,
      storedPreview: stored ? stored.slice(0, 20) + '...' : '',
      browserPreview: fcmToken ? fcmToken.slice(0, 20) + '...' : ''
    });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

app.post('/api/fcm/register', requireAuth, async (req, res) => {
  try {
    let { fcmToken } = req.body;
    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.length < 20) {
      return res.status(400).json({ success: false, error: 'invalid token' });
    }
    fcmToken = fcmToken.trim();
    console.log('FCM register: user', req.session.user.id, 'token length:', fcmToken.length);
    const uid = req.session.user.id;
    // Remove token from any other user (duplicate)
    const prisma = getPrisma();
    const dups = await prisma.user.findMany({ where: { fcmToken, id: { not: uid } }, select: { id: true } });
    for (const dup of dups) {
      await prisma.user.update({ where: { id: dup.id }, data: { fcmToken: '' } });
    }
    // Save token to this user
    await prisma.user.update({ where: { id: uid }, data: { fcmToken } });
    // Refresh session
    const fresh = await getPrisma().user.findUnique({ where: { id: uid } });
    if (fresh) req.session.user = sessionUser(fresh);
    console.log('FCM register: saved for user', uid);
    res.json({ success: true });
  } catch (e) {
    console.error('FCM register error:', e.message);
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

// ===================== FCM DIAGNOSTIC ENDPOINTS =====================

app.get('/api/fcm/debug', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    const adminUser = await prisma.user.findUnique({ where: { id: req.session.user.id }, select: { id: true, name: true, fcmToken: true } }) || {};
    const allWithToken = await prisma.user.findMany({ where: { deletedAt: null, NOT: { fcmToken: '' } }, select: { id: true, name: true, role: true, fcmToken: true } });
    var mappedTokens = allWithToken.map(u => ({ id: u.id, name: u.name, role: u.role, tokenPreview: (u.fcmToken || '').slice(0, 15) + '...' }));
    res.json({
      admin: {
        id: adminUser.id,
        name: adminUser.name,
        hasToken: !!adminUser.fcmToken,
        tokenPreview: adminUser.fcmToken ? adminUser.fcmToken.slice(0, 15) + '...' : null,
        tokenLength: (adminUser.fcmToken || '').length
      },
      firebaseAdmin: {
        initialized: !!(await (async () => { try { const a = require('./prisma-bridge'); return a.fbAuth !== null; } catch(e) { return false; } })()),
        projectId: process.env.FIREBASE_PROJECT_ID || (() => { try { const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); return sa.project_id; } catch(e) { return null; } })()
      },
      vapidPreview: process.env.FIREBASE_VAPID_KEY ? process.env.FIREBASE_VAPID_KEY.slice(0, 10) + '...' + process.env.FIREBASE_VAPID_KEY.slice(-10) : null,
      allTokens: mappedTokens,
      totalUsersWithToken: mappedTokens.length,
      logs: fcmLog.list(20)
    });
  } catch (e) { console.error('[FCM debug]', e.message); res.status(500).json({ error: safeErr(e) }); }
});

app.post('/api/fcm/test', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    const adminUser = await prisma.user.findUnique({ where: { id: req.session.user.id }, select: { id: true, name: true, fcmToken: true } });
    if (!adminUser || !adminUser.fcmToken) {
      return res.json({ success: false, error: 'ليس لديك Token FCM مسجل', errorCode: 'NO_TOKEN' });
    }
    const testBody = { token: adminUser.fcmToken, notification: { title: '🔧 إشعار اختبار من لوحة التشخيص', body: 'إذا رأيت هذه الرسالة فهذا يعني أن FCM يعمل بشكل صحيح ✅' }, data: { url: '/admin/fcm-debug' } };
    let result;
    try {
      result = await admin.messaging().send(testBody);
      fcmLog.add({ userId: adminUser.id, title: '🔧 اختبار تشخيص', messageId: result, success: true, error: null });
      res.json({ success: true, messageId: result, error: null });
    } catch (e) {
      fcmLog.add({ userId: adminUser.id, title: '🔧 اختبار تشخيص', messageId: null, success: false, error: e.code || e.message });
      res.json({ success: false, messageId: null, error: 'فشل إرسال الإشعار', errorCode: e.code || 'UNKNOWN', errorInfo: null });
    }
  } catch (e) { console.error('[FCM test]', e.message); res.status(500).json({ success: false, error: safeErr(e) }); }
});

// Migration: RTDB → Firestore (one-time)
app.get('/admin/fcm-debug', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    const users = await prisma.user.findMany({ where: { deletedAt: null }, select: { id: true, name: true, role: true, email: true, fcmToken: true } });
    const user = await prisma.user.findUnique({ where: { id: req.session.user.id }, select: { id: true, name: true, fcmToken: true } }) || {};
    const _vapidKey = process.env.FIREBASE_VAPID_KEY || '';
    res.render('admin/fcm-debug', {
      title: 'تشخيص الإشعارات',
      bodyClass: 'admin-body',
      user: req.session.user,
      currentPath: req.path,
      users: users,
      firebaseConfig: res.locals.firebaseConfig || {},
      vapidKey: _vapidKey,
      vapidPreview: _vapidKey ? _vapidKey.slice(0, 10) + '...' + _vapidKey.slice(-10) : '',
      darkMode: res.locals.darkMode,
      adminFcmToken: user.fcmToken || ''
    });
  } catch (e) { console.error('[FCM page]', e.message); res.status(500).send(safeErr(e)); }
});

app.get('/admin/comprehensive-exam', requireAdmin, async (req, res) => {
  try {
    console.log('[comprehensive-exam] Route accessed');
    const existingExam = await readData('comprehensiveExam');
    console.log('[comprehensive-exam] Exam data:', existingExam);
    res.render('admin/comprehensive-exam', {
      title: 'شامل المنهج - الإدارة',
      bodyClass: 'admin-body',
      user: req.session.user,
      currentPath: req.path,
      existingExam: existingExam || null,
      darkMode: res.locals.darkMode
    });
  } catch (e) {
    console.error('[comprehensive-exam page]', e.message);
    res.status(500).send(safeErr(e));
  }
});

app.post('/api/admin/send-notification', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    const { title, body, target, targetValue } = req.body;
    var where = { role: 'student', deletedAt: null, NOT: { fcmToken: '' } };
    if (target === 'grade') where.grade = targetValue;
    else if (target === 'stage') where.stage = targetValue;
    else if (target === 'student') where.id = targetValue;
    let recipients = await prisma.user.findMany({ where, select: { id: true, fcmToken: true } });

    const notifications = await readData('notifications') || [];
    const notif = {
      id: 'notif-' + Date.now(),
      title, body, target, targetValue
    };
    notifications.push(notif);
    await writeData('notifications', notifications);

    // Send actual FCM push notifications
    let sent = 0;
    for (const u of recipients) {
      const ok = await sendFCM(u.id, title, body, '/');
      if (ok) sent++;
    }

    res.json({ success: true, recipientCount: recipients.length, sentCount: sent, notification: notif });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== Scheduled Notifications API ===================== */

// Fire-and-forget: run scheduler check without blocking the response
function triggerSchedulerCheck() {
  checkScheduledNotifications().then(function(r) {
    if (r.processed > 0) console.log('[scheduler] Processed ' + r.processed + ' notification(s)');
  }).catch(function(){});
}

// GET /api/admin/scheduled-notifications — List all scheduled notifications
app.get('/api/admin/scheduled-notifications', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    const list = await readData('scheduledNotifications') || [];
    const users = await prisma.user.findMany({ where: { deletedAt: null }, select: { id: true, name: true } });
    const userById = {};
    users.forEach(u => { if (u && u.id) userById[u.id] = u; });
    const enriched = list.map(n => {
      const out = Object.assign({}, n);
      if (n.target === 'student' && n.targetValue) {
        const u = userById[n.targetValue];
        out.targetName = u ? (u.name || u.id) : ('طالب (' + n.targetValue + ')');
      } else if (n.target === 'grade' && n.targetValue) {
        out.targetName = 'صف: ' + n.targetValue;
      } else if (n.target === 'stage' && n.targetValue) {
        out.targetName = 'مرحلة: ' + n.targetValue;
      } else {
        out.targetName = 'جميع الطلاب';
      }
      return out;
    });
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// POST /api/admin/schedule-notification — Create a scheduled notification
app.post('/api/admin/schedule-notification', requireAdmin, async (req, res) => {
  try {
    const { title, body, target, targetValue, scheduledAt } = req.body;
    if (!title || !body || !scheduledAt) return res.status(400).json({ error: 'العنوان والنص والموعد حقول مطلوبة.' });
    const dt = new Date(scheduledAt);
    if (dt <= new Date()) return res.status(400).json({ error: 'لا يمكن اختيار وقت في الماضي.' });

    const list = await readData('scheduledNotifications') || [];
    const notif = {
      id: 'sched-' + Date.now(),
      title, body,
      target: target || 'all',
      targetValue: targetValue || '',
      scheduledAt: dt.toISOString(),
      createdAt: new Date().toISOString(),
      createdBy: req.session.user ? req.session.user.name || req.session.user.id : 'admin',
      status: 'Pending',
      sentAt: null,
      error: null
    };
    list.push(notif);
    await writeData('scheduledNotifications', list);
    res.json({ success: true, notification: notif });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// PUT /api/admin/schedule-notification/:id — Update a pending scheduled notification
app.put('/api/admin/schedule-notification/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, body, target, targetValue, scheduledAt } = req.body;
    if (!title || !body || !scheduledAt) return res.status(400).json({ error: 'العنوان والنص والموعد حقول مطلوبة.' });
    const dt = new Date(scheduledAt);
    if (dt <= new Date()) return res.status(400).json({ error: 'لا يمكن اختيار وقت في الماضي.' });

    const list = await readData('scheduledNotifications') || [];
    const idx = list.findIndex(n => n.id === id);
    if (idx === -1) return res.status(404).json({ error: 'الإشعار غير موجود.' });
    if (list[idx].status !== 'Pending') return res.status(400).json({ error: 'لا يمكن تعديل إشعار تم إرساله أو إلغاؤه.' });

    list[idx].title = title;
    list[idx].body = body;
    list[idx].target = target || 'all';
    list[idx].targetValue = targetValue || '';
    list[idx].scheduledAt = dt.toISOString();
    await writeData('scheduledNotifications', list);
    res.json({ success: true, notification: list[idx] });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// DELETE /api/admin/schedule-notification/:id — Delete a scheduled notification
app.delete('/api/admin/schedule-notification/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const list = await readData('scheduledNotifications') || [];
    const idx = list.findIndex(n => n.id === id);
    if (idx === -1) return res.status(404).json({ error: 'الإشعار غير موجود.' });
    list.splice(idx, 1);
    await writeData('scheduledNotifications', list);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// POST /api/admin/schedule-notification/:id/send-now — Send immediately
app.post('/api/admin/schedule-notification/:id/send-now', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const list = await readData('scheduledNotifications') || [];
    const idx = list.findIndex(n => n.id === id);
    if (idx === -1) return res.status(404).json({ error: 'الإشعار غير موجود.' });
    if (list[idx].status !== 'Pending') return res.status(400).json({ error: 'لا يمكن إرسال إشعار تم إرساله أو إلغاؤه مسبقاً.' });

    list[idx].status = 'Sending';
    await writeData('scheduledNotifications', list);

    const result = await sendScheduledNotification(list[idx]);
    list[idx].status = result.success ? 'Sent' : 'Failed';
    list[idx].sentAt = result.success ? new Date().toISOString() : null;
    list[idx].error = result.error || null;
    await writeData('scheduledNotifications', list);

    res.json({ success: result.success, sentCount: result.sentCount, error: result.error });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// POST /api/admin/schedule-notification/:id/cancel — Cancel a scheduled notification
app.post('/api/admin/schedule-notification/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const list = await readData('scheduledNotifications') || [];
    const idx = list.findIndex(n => n.id === id);
    if (idx === -1) return res.status(404).json({ error: 'الإشعار غير موجود.' });
    if (list[idx].status !== 'Pending') return res.status(400).json({ error: 'لا يمكن إلغاء إشعار تم إرساله مسبقاً.' });
    list[idx].status = 'Cancelled';
    await writeData('scheduledNotifications', list);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// GET /api/admin/notifications/check-scheduled — Trigger manual check (for external cron jobs)
app.get('/api/admin/notifications/check-scheduled', requireAdmin, async (req, res) => {
  try {
    const result = await runSchedulerCheck();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

/* ===================== Scheduler Engine ===================== */

async function sendScheduledNotification(notif) {
  try {
    var prisma = getPrisma();
    var where = { role: 'student', deletedAt: null, NOT: { fcmToken: '' } };
    if (notif.target === 'grade') where.grade = notif.targetValue;
    else if (notif.target === 'stage') where.stage = notif.targetValue;
    else if (notif.target === 'student') where.id = notif.targetValue;
    let recipients = await prisma.user.findMany({ where, select: { id: true, fcmToken: true } });

    if (!admin.messaging) return { success: false, sentCount: 0, error: 'FCM غير متاح' };

    let sent = 0;
    var invalidIds = [];
    for (const u of recipients) {
      try {
        const message = { token: u.fcmToken, notification: { title: notif.title, body: notif.body }, data: { url: '/' } };
        await admin.messaging().send(message);
        sent++;
      } catch (e) {
        console.error('scheduled-notification FCM error for', u.id, ':', e.code || e.message);
        if (e.code === 'messaging/invalid-registration-token' || e.code === 'messaging/registration-token-not-registered') {
          invalidIds.push(u.id);
        }
      }
    }
    if (invalidIds.length) {
      await prisma.user.updateMany({ where: { id: { in: invalidIds } }, data: { fcmToken: '' } });
    }

    // Also log to notifications history (same as instant)
    const notifications = await readData('notifications') || [];
    notifications.push({
      id: notif.id,
      title: notif.title,
      body: notif.body,
      target: notif.target,
      targetValue: notif.targetValue
    });
    await writeData('notifications', notifications);

    return { success: true, sentCount: sent, error: null };
  } catch (e) {
    console.error('sendScheduledNotification error:', e.message);
    return { success: false, sentCount: 0, error: 'SEND_FAILED' };
  }
}

async function checkScheduledNotifications() {
  try {
    var { transactionData } = require('./prisma-bridge');
    var now = new Date();
    var processed = 0;

    // Atomic claim: transition due notifications from Pending → Sending atomically
    await transactionData('scheduledNotifications', function(current) {
      if (!Array.isArray(current)) return current;
      var changed = false;
      for (var i = 0; i < current.length; i++) {
        if (current[i].status === 'Pending' && new Date(current[i].scheduledAt) <= now) {
          current[i].status = 'Sending';
          changed = true;
        }
      }
      return changed ? current : undefined; // undefined = abort transaction (no change)
    });

    // Read back the notifications we claimed
    var allNotifs = await readData('scheduledNotifications') || [];
    var sending = allNotifs.filter(function(n) { return n.status === 'Sending'; });

    for (var si = 0; si < sending.length; si++) {
      var notif = sending[si];
      var result = await sendScheduledNotification(notif);
      var idx = -1;
      for (var fi = 0; fi < allNotifs.length; fi++) {
        if (allNotifs[fi].id === notif.id) { idx = fi; break; }
      }
      if (idx !== -1) {
        allNotifs[idx].status = result.success ? 'Sent' : 'Failed';
        allNotifs[idx].sentAt = result.success ? new Date().toISOString() : null;
        allNotifs[idx].error = result.error || null;
      }
      processed++;
    }

    if (processed > 0) {
      await writeData('scheduledNotifications', allNotifs);
    }
    return { checked: true, processed: processed };
  } catch (e) {
    console.error('checkScheduledNotifications error:', e.message);
    return { checked: true, processed: 0, error: 'CHECK_FAILED' };
  }
}

// Run scheduler every 30 seconds
const SCHEDULER_INTERVAL = 30000;
let schedulerTimer = null;

async function recordCronRun(result) {
  try {
    await writeData('cronLastRun', {
      at: new Date().toISOString(),
      processed: result && result.processed ? result.processed : 0,
      checked: result ? result.checked : false,
      error: result && result.error ? result.error : null
    });
  } catch (e) { /* non-fatal */ }
}

async function runSchedulerCheck() {
  try {
    const result = await checkScheduledNotifications();
    await recordCronRun(result);
    return result;
  } catch (e) {
    console.error('[cron] error:', e.message);
    await recordCronRun({ checked: false, processed: 0, error: 'CRON_FAILED' });
    return { checked: false, processed: 0, error: 'CRON_FAILED' };
  }
}

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  console.log('[scheduler] Starting scheduled notifications checker every ' + (SCHEDULER_INTERVAL / 1000) + 's');
  schedulerTimer = setInterval(() => {
    runSchedulerCheck().then(r => {
      if (r.processed > 0) console.log('[scheduler] Processed ' + r.processed + ' scheduled notification(s)');
    });
  }, SCHEDULER_INTERVAL);
  // Also run once immediately after startup
  setTimeout(() => {
    runSchedulerCheck().then(r => {
      if (r.processed > 0) console.log('[scheduler] Initial check processed ' + r.processed + ' notification(s)');
    });
  }, 5000);
}

startScheduler();

// Scheduler check is now triggered exclusively by cron-job.org hitting /api/cron/check-scheduled
// (The admin page and middleware are NOT used to avoid duplicate processing)

// One-time admin endpoint: store CRON_SECRET in Firebase
app.get('/api/admin/set-cron-secret', requireAdmin, async (req, res) => {
  try {
    var s = (req.query.secret || '').trim();
    if (!s) return res.status(400).send('يرجى إدخال secret');
    var cfg = {};
    try { var cur = await readData('appConfig'); if (cur) cfg = cur; } catch(e) {}
    cfg.cronSecret = s;
    await writeData('appConfig', cfg);
    res.send('<h2 style="font-family:Cairo;color:#22c55e;padding:20px;">✅ تم حفظ CRON_SECRET في Firebase</h2><p style="font-family:Cairo;padding:0 20px;">الرابط: https://almumayaz.online/api/cron/check-scheduled?key=' + s + '</p>');
  } catch (e) {
    res.status(500).send(safeErr(e, 'فشل'));
  }
});

// ===================== Platform Theme (colors + button shape) =====================
function hexToRgb(hex) {
  if (!hex) return null;
  hex = String(hex).replace('#', '').trim();
  if (hex.length === 3) hex = hex.split('').map(function(c){return c+c;}).join('');
  if (hex.length !== 6) return null;
  return { r: parseInt(hex.slice(0,2),16), g: parseInt(hex.slice(2,4),16), b: parseInt(hex.slice(4,6),16) };
}
function rgbToHex(c) {
  var h = function(n){ var s = Math.max(0, Math.min(255, Math.round(n))).toString(16); return s.length===1?'0'+s:s; };
  return '#' + h(c.r) + h(c.g) + h(c.b);
}
function mixRgb(a, b, t) { return { r: a.r+(b.r-a.r)*t, g: a.g+(b.g-a.g)*t, b: a.b+(b.b-a.b)*t }; }
function btnShapeRadius(shape) {
  if (shape === 'square') return '0px';
  if (shape === 'circular') return '999px';
  return '12px'; // rounded (نصف دائرية)
}
var DEFAULT_LIGHT = { bg: '#FFF9F1', card: '#FFFFFF', border: '#E8E8E8', text: '#111111', textLight: '#666666', textMuted: '#9A8A7A', cardAlt: '#f5f5f5', glassBg: 'rgba(255,255,255,0.85)', glassBorder: 'rgba(0,0,0,0.06)', glassBlur: '20px', sidebarTextHover: '#000000', sidebarTextActive: '#000000', sidebarIconHover: '#000000', sidebarIconActive: '#000000', sidebarLogout: '#ef4444' };
var DEFAULT_DARK = { bg: '#0F172A', card: '#1E293B', border: 'rgba(255,255,255,0.08)', text: '#F1F5F9', textLight: '#94A3B8', textMuted: '#64748B', cardAlt: '#111827', glassBg: 'rgba(255,255,255,0.06)', glassBorder: 'rgba(255,255,255,0.1)', glassBlur: '24px', sidebarTextHover: 'var(--accent)', sidebarTextActive: 'var(--accent)', sidebarIconHover: 'var(--accent)', sidebarIconActive: 'var(--accent)', sidebarLogout: '#f87171' };

function pickHex(obj, key, fallback) { return (obj && obj[key]) || fallback; }

async function buildThemeCss(theme) {
  if (!theme || !theme.accent) return '';
  var rgb = hexToRgb(theme.accent) || { r: 245, g: 158, b: 11 };
  var light = mixRgb(rgb, { r: 255, g: 255, b: 255 }, 0.35);
  var lighter = mixRgb(rgb, { r: 255, g: 255, b: 255 }, 0.6);
  var hover = mixRgb(rgb, { r: 0, g: 0, b: 0 }, 0.15);
  var hex = theme.accent;
  var glow = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.18)';
  var radius = btnShapeRadius(theme.btnShape);
  var fontName = theme.fontName ? theme.fontName.replace(/"/g, '') : '';
  var fd = theme.fontData;
  var fontFaceCss = '';
  if (fd && fd.data) {
    if (fd.r2 && storageConfig.isR2Enabled()) {
      try {
        var fontUrl = await getStorageService().createPublicUrl(fd.data);
        fontFaceCss = '@font-face{font-family:"' + (fd.name || fontName || 'CustomFont') + '";src:url("' + fontUrl + '") format("' + (fd.format || 'woff2') + '");font-display:swap;}';
      } catch (_) {}
    } else {
      fontFaceCss = '@font-face{font-family:"' + (fd.name || fontName || 'CustomFont') + '";src:url("data:' + (fd.mime || 'font/woff2') + ';base64,' + fd.data + '") format("' + (fd.format || 'woff2') + '");font-display:swap;}';
    }
  }
  var lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  var btnText = lum > 0.5 ? '#111111' : '#F1F5F9';
  var fontCss = fontName ? 'font-family:"' + fontName + '",sans-serif;' : '';
  var fontBodyCss = fontName ? 'body,input,textarea,select,button,.navbar,.nav-links a,.sidebar-logo,.btn,.form-input,.sp-info-value,.sp-code{font-family:"' + fontName + '",sans-serif!important;}' : '';

  var lt = theme.light || {};
  var dk = theme.dark || {};
  var sharedVars =
    '--primary:' + hex + ';' +
    '--primary-light:' + rgbToHex(light) + ';' +
    '--primary-lighter:' + rgbToHex(lighter) + ';' +
    '--accent:' + hex + ';' +
    '--accent-light:' + rgbToHex(light) + ';' +
    '--accent-hover:' + rgbToHex(hover) + ';' +
    '--accent-glow:' + glow + ';' +
    '--btn-text:' + btnText + ';' +
    '--gold-gradient:linear-gradient(135deg,' + hex + ' 0%,' + rgbToHex(hover) + ' 100%);' +
    '--gold-gradient-text:linear-gradient(90deg,' + hex + ',' + rgbToHex(hover) + ');' +
    '--shadow-accent:0 8px 25px rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.25);' +
    '--course-c1:' + hex + ';' +
    '--course-c2:' + rgbToHex(mixRgb(rgb, { r: 109, g: 74, b: 255 }, 0.55)) + ';' +
    '--course-c3:' + rgbToHex(mixRgb(rgb, { r: 13, g: 148, b: 136 }, 0.55)) + ';' +
    '--course-c4:' + rgbToHex(mixRgb(rgb, { r: 184, g: 134, b: 11 }, 0.5)) + ';' +
    '--btn-radius:' + radius + ';' +
    fontCss;

  function themeBlock(prefix, src, def) {
    return prefix + '{' +
      '--bg:' + pickHex(src, 'bg', def.bg) + ';' +
      '--card:' + pickHex(src, 'card', def.card) + ';' +
      '--card-alt:' + pickHex(src, 'cardAlt', def.cardAlt) + ';' +
      '--border:' + pickHex(src, 'border', def.border) + ';' +
      '--text:' + pickHex(src, 'text', def.text) + ';' +
      '--text-light:' + pickHex(src, 'textLight', def.textLight) + ';' +
      '--text-muted:' + pickHex(src, 'textMuted', def.textMuted) + ';' +
      '--glass-bg:' + pickHex(src, 'glassBg', def.glassBg) + ';' +
      '--glass-border:' + pickHex(src, 'glassBorder', def.glassBorder) + ';' +
      '--glass-blur:' + pickHex(src, 'glassBlur', def.glassBlur) + ';' +
      '--sidebar-text-hover:' + pickHex(src, 'sidebarTextHover', def.sidebarTextHover) + ';' +
      '--sidebar-text-active:' + pickHex(src, 'sidebarTextActive', def.sidebarTextActive) + ';' +
      '--sidebar-icon-hover:' + pickHex(src, 'sidebarIconHover', def.sidebarIconHover) + ';' +
      '--sidebar-icon-active:' + pickHex(src, 'sidebarIconActive', def.sidebarIconActive) + ';' +
      '--sidebar-logout:' + pickHex(src, 'sidebarLogout', def.sidebarLogout) + ';' +
      sharedVars +
      '}';
  }

  return fontFaceCss +
    themeBlock(':root,[data-theme="light"]', lt, DEFAULT_LIGHT) +
    themeBlock('[data-theme="dark"]', dk, DEFAULT_DARK) +
    '.btn,.btn-lg,.btn-sm,.btn-outline,.btn-primary,.btn-danger,.action-btn{border-radius:var(--btn-radius,14px)!important;}' +
    fontBodyCss;
}

let themeCache = { css: '', at: 0, TTL: 60000 };
async function getThemeCss(force) {
  const now = Date.now();
  if (!force && themeCache.css && now - themeCache.at < themeCache.TTL) return themeCache.css;
  try {
    const t = await readData('themeConfig');
    let css = await buildThemeCss(t);
    if (t && t.fontName && !(t.fontData && t.fontData.data)) {
      const fn = encodeURIComponent(t.fontName.trim()).replace(/%20/g, '+');
      try {
        const resp = await fetch('https://fonts.googleapis.com/css2?family=' + fn + ':wght@300;400;500;600;700;800;900&display=swap');
        if (resp.ok) css = (await resp.text()) + '\n' + css;
      } catch (_) {}
    }
    themeCache.css = css;
    themeCache.at = now;
    return css;
  } catch (e) {
    return themeCache.css || '';
  }
}

// GET /dev — Developer login page (password-protected)
app.get('/dev', function(req, res) {
  if (req.session.devPanelAccess) {
    return res.redirect('/dev/dashboard');
  }
  res.render('dev/login');
});

// POST /dev/login — Verify dev password
app.post('/dev/login', function(req, res) {
  var pw = (req.body.password || '').trim();
  if (pw === (process.env.DEV_PASSWORD || '')) {
    req.session.devPanelAccess = true;
    return res.json({ success: true });
  }
  return res.json({ success: false, error: 'كلمة المرور غير صحيحة' });
});

// POST /dev/logout
app.post('/dev/logout', function(req, res) {
  req.session.devPanelAccess = false;
  res.json({ success: true });
});

// GET /dev/dashboard — Developer control panel
app.get('/dev/dashboard', requireDevAccess, async (req, res) => {
  try {
    var creds = await zoom.getStoredCredentials();
    var cid = creds ? creds.clientId : (process.env.ZOOM_CLIENT_ID || '');
    var csec = creds ? creds.clientSecret : (process.env.ZOOM_CLIENT_SECRET || '');
    var ruri = creds ? creds.redirectUri : (process.env.ZOOM_REDIRECT_URI || '');
    var sk = creds ? creds.sdkKey : (process.env.ZOOM_SDK_KEY || '');
    var ssec = creds ? creds.sdkSecret : (process.env.ZOOM_SDK_SECRET || '');
    var theme = {};
    try { theme = await readData('themeConfig') || {}; } catch (e) {}
    var settings = await readData('settings') || {};
    res.render('dev/panel', {
      clientId: cid ? cid.substring(0, 6) + '…' : '',
      clientIdFull: cid,
      clientSecretFull: csec,
      redirectUri: ruri,
      sdkKeyFull: sk,
      sdkSecretFull: ssec,
      themeAccent: theme.accent || '#F59E0B',
      themeBtnShape: theme.btnShape || 'rounded',
      themeFont: theme.fontName || '',
      themeFontFile: (theme.fontData && theme.fontData.fileName) || '',
      themeLightBg: (theme.light && theme.light.bg) || '#FFF9F1',
      themeLightCard: (theme.light && theme.light.card) || '#FFFFFF',
      themeLightText: (theme.light && theme.light.text) || '#111111',
      themeLightSidebarTextHover: (theme.light && theme.light.sidebarTextHover) || '#000000',
      themeLightSidebarTextActive: (theme.light && theme.light.sidebarTextActive) || '#000000',
      themeLightSidebarIconHover: (theme.light && theme.light.sidebarIconHover) || '#000000',
      themeLightSidebarIconActive: (theme.light && theme.light.sidebarIconActive) || '#000000',
      themeLightSidebarLogout: (theme.light && theme.light.sidebarLogout) || '#ef4444',
      themeDarkBg: (theme.dark && theme.dark.bg) || '#0F172A',
      themeDarkCard: (theme.dark && theme.dark.card) || '#1E293B',
      themeDarkText: (theme.dark && theme.dark.text) || '#F1F5F9',
      themeDarkSidebarTextHover: (theme.dark && theme.dark.sidebarTextHover) || '#FBBF24',
      themeDarkSidebarTextActive: (theme.dark && theme.dark.sidebarTextActive) || '#FBBF24',
      themeDarkSidebarIconHover: (theme.dark && theme.dark.sidebarIconHover) || '#FBBF24',
      themeDarkSidebarIconActive: (theme.dark && theme.dark.sidebarIconActive) || '#FBBF24',
      themeDarkSidebarLogout: (theme.dark && theme.dark.sidebarLogout) || '#f87171',
      supportKey: settings.supportKey || '',
      title: 'Developer Panel'
    });
  } catch (e) {
    res.status(500).send(safeErr(e, 'فشل تحميل لوحة المطور'));
  }
});

// GET /admin/dev — Developer control panel (Zoom settings + cron control) — legacy alias
app.get('/admin/dev', requireAdmin, async (req, res) => {
  try {
    var creds = await zoom.getStoredCredentials();
    var cid = creds ? creds.clientId : (process.env.ZOOM_CLIENT_ID || '');
    var csec = creds ? creds.clientSecret : (process.env.ZOOM_CLIENT_SECRET || '');
    var ruri = creds ? creds.redirectUri : (process.env.ZOOM_REDIRECT_URI || '');
    var sk = creds ? creds.sdkKey : (process.env.ZOOM_SDK_KEY || '');
    var ssec = creds ? creds.sdkSecret : (process.env.ZOOM_SDK_SECRET || '');
    var settings = await readData('settings') || {};
    res.render('admin/dev', {
      clientId: cid ? cid.substring(0, 6) + '…' : '',
      clientIdFull: cid,
      clientSecretFull: csec,
      clientSecretDisplay: csec ? csec.substring(0, 6) + '…' : '',
      redirectUri: ruri,
      sdkKeyFull: sk,
      sdkSecretFull: ssec,
      supportKey: settings.supportKey || '',
      title: 'لوحة المطور - الإدارة'
    });
  } catch (e) {
    res.status(500).send(safeErr(e, 'فشل تحميل لوحة المطور'));
  }
});

// GET /api/dev/status — Developer panel status (Zoom + cron)
app.get('/api/dev/status', requireDevAccess, async (req, res) => {
  try {
    var creds = await zoom.getStoredCredentials();
    var clientId = creds ? creds.clientId : (process.env.ZOOM_CLIENT_ID || '');
    var status = {
      zoom: {
        configured: !!(clientId && (creds ? creds.clientSecret : process.env.ZOOM_CLIENT_SECRET)),
        hasFirebaseCreds: !!(creds && creds.clientId),
        clientIdPrefix: clientId ? clientId.substring(0, 6) + '…' : '',
        redirectUri: creds ? creds.redirectUri : (process.env.ZOOM_REDIRECT_URI || ''),
        hasSdk: !!(creds && creds.sdkKey)
      },
      cron: { intervalSeconds: SCHEDULER_INTERVAL / 1000 }
    };
    try { var lr = await readData('cronLastRun'); if (lr) status.cron.lastRun = lr; } catch (e) {}
    try {
      var cfg = await readData('appConfig');
      status.cron.secretSet = !!(cfg && cfg.cronSecret);
      if (cfg && cfg.cronSecret) {
        status.cron.cronUrl = 'https://almumayaz.online/api/cron/check-scheduled?key=' + cfg.cronSecret;
      }
    } catch (e) {}
    try { var mm = await readData('maintenanceMode'); status.maintenance = mm || { enabled: false, message: '' }; } catch (e) {}
    // FCM status
    try {
      var prisma = getPrisma();
      const totalUsersWithToken = await prisma.user.count({ where: { deletedAt: null, NOT: { fcmToken: '' } } });
      const adminUser = await prisma.user.findUnique({ where: { id: req.session.user.id }, select: { fcmToken: true } });
      status.fcm = {
        firebaseAdmin: { initialized: true, projectId: process.env.FIREBASE_PROJECT_ID || 'almumayaz' },
        admin: { hasToken: !!(adminUser && adminUser.fcmToken), tokenLength: (adminUser && adminUser.fcmToken) ? adminUser.fcmToken.length : 0 },
        totalUsersWithToken: totalUsersWithToken
      };
    } catch (e) { status.fcm = { firebaseAdmin: { initialized: false }, admin: { hasToken: false }, totalUsersWithToken: 0 }; }
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// GET /api/dev/usage — Usage statistics dashboard
app.get('/api/dev/usage', requireDevAccess, async (req, res) => {
  try {
    var stats = await usageTracker.getStats();
    stats._perf = perf.getGlobalMetrics();
    // Fetch real Brevo account data
    try {
      var brevoKey = process.env.BREVO_API_KEY;
      if (brevoKey) {
        var https = require('https');
        stats._brevo = {};
        // Account info (plan credits)
        var acc = await new Promise(function(resolve, reject) {
          var opts = { hostname: 'api.brevo.com', path: '/v3/account', headers: { 'api-key': brevoKey, 'Accept': 'application/json' } };
          https.get(opts, function(r) { var d = ''; r.on('data', function(c) { d += c; }); r.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }).on('error', reject);
        });
        if (acc && acc.plan) {
          stats._brevo.plan = acc.plan.map(function(p) { return { type: p.type, credits: p.credits, creditsType: p.creditsType }; });
          stats._brevo.email = acc.email;
          stats._brevo.companyName = acc.companyName;
        }
        // Aggregated SMTP stats (last 30 days)
        var smtp = await new Promise(function(resolve, reject) {
          var opts = { hostname: 'api.brevo.com', path: '/v3/smtp/statistics/aggregatedReport?days=30', headers: { 'api-key': brevoKey, 'Accept': 'application/json' } };
          https.get(opts, function(r) { var d = ''; r.on('data', function(c) { d += c; }); r.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }).on('error', reject);
        });
        if (smtp) stats._brevo.smtp30 = smtp;
        // Daily reports (last 7 days)
        var daily = await new Promise(function(resolve, reject) {
          var opts = { hostname: 'api.brevo.com', path: '/v3/smtp/statistics/reports?days=7&limit=7', headers: { 'api-key': brevoKey, 'Accept': 'application/json' } };
          https.get(opts, function(r) { var d = ''; r.on('data', function(c) { d += c; }); r.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }).on('error', reject);
        });
        if (daily && daily.reports) stats._brevo.daily7 = daily.reports;
      }
    } catch (e) { console.error('[Usage] Brevo fetch error:', e.message); }
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// POST /api/dev/maintenance — Toggle maintenance mode (platform on/off)
app.post('/api/dev/maintenance', requireDevAccess, async (req, res) => {
  try {
    var enabled = !!req.body.enabled;
    var message = (req.body.message || '').toString().trim();
    await writeData('maintenanceMode', {
      enabled: enabled,
      message: message,
      updatedAt: new Date().toISOString(),
      updatedBy: req.session.user ? (req.session.user.name || req.session.user.id) : 'admin'
    });
    res.json({ success: true, enabled: enabled });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// POST /api/dev/notify-teacher — Send a push notification to the teacher (admin)
app.post('/api/dev/notify-teacher', requireDevAccess, async (req, res) => {
  try {
    var title = (req.body.title || '').trim();
    var body = (req.body.body || '').trim();
    var url = (req.body.url || '/admin').trim() || '/admin';
    if (!title || !body) return res.status(400).json({ error: 'العنوان والنص مطلوبان.' });
    var sent = 0;
    if (typeof admin !== 'undefined' && admin && admin.messaging) {
      sent = await sendFCMToRole('admin', title, body, url);
    }
    // Also record in notification history so it appears in the admin notification center
    try {
      var notifications = await readData('notifications') || [];
      notifications.push({
        id: 'dev-' + Date.now(),
        title: title,
        body: body,
        target: 'admin',
        targetValue: ''
      });
      await writeData('notifications', notifications);
    } catch (e) {}
    res.json({ success: true, sent: sent });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// POST /api/dev/support-key — set support key
app.post('/api/dev/support-key', requireDevAccess, async (req, res) => {
  try {
    var key = (req.body.key || '').trim();
    if (!key) return res.json({ success: false, error: 'المفتاح مطلوب' });
    var settings = await readData('settings') || {};
    settings.supportKey = key;
    await writeData('settings', settings);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: safeErr(e) });
  }
});

// Public cron endpoint for Vercel Cron Jobs (x-vercel-cron) / cron-job.org (?key=SECRET)
app.get('/api/cron/check-scheduled', async function(req, res) {
  // Accept secret from env var OR Firebase (appConfig.cronSecret)
  var envSecret = process.env.CRON_SECRET || '';
  var fbSecret = '';
  try { var cfg = await readData('appConfig'); if (cfg && cfg.cronSecret) fbSecret = cfg.cronSecret; } catch(e) {}
  var provided = req.query.key || '';
  if (provided !== envSecret && provided !== fbSecret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    var result = await runSchedulerCheck();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});



function clearAllFcm() {
  return (async () => {
    const prisma = getPrisma();
    const result = await prisma.user.updateMany({
      where: { fcmToken: { not: '' } },
      data: { fcmToken: '' },
    });
    return result.count;
  })();
}

app.post('/api/admin/clear-all-fcm', requireAdmin, async (req, res) => {
  try {
    const cleared = await clearAllFcm();
    res.json({ success: true, cleared: cleared });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

app.get('/api/admin/clear-all-fcm', requireAdmin, async (req, res) => {
  try {
    const cleared = await clearAllFcm();
    res.json({ success: true, cleared: cleared });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

app.get('/api/admin/fcm-debug', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    var adminUser = await prisma.user.findFirst({ where: { role: 'admin', deletedAt: null }, select: { id: true, fcmToken: true } });
    const token = adminUser && adminUser.fcmToken ? adminUser.fcmToken : '';
    const vapid = process.env.FIREBASE_VAPID_KEY || '';
    res.json({
      adminHasToken: !!token,
      tokenLength: token.length,
      tokenFull: token,
      tokenPrefix: token ? token.split(':')[0] : '',
      uid: adminUser ? adminUser.id : 'NO ADMIN',
      role: adminUser ? adminUser.role : 'none',
      projectId: stripBOM(process.env.FIREBASE_PROJECT_ID || '') || 'NOT SET',
      senderId: stripBOM(process.env.FIREBASE_MESSAGING_SENDER_ID || '') || 'NOT SET',
      vapidFirst10: vapid ? vapid.slice(0, 10) : 'NOT SET',
      vapidLast10: vapid ? vapid.slice(-10) : 'NOT SET',
      vapidLength: vapid.length
    });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

app.get('/api/admin/fcm-project', requireAdmin, async (req, res) => {
  try {
    let projectId = 'unknown', databaseURL = 'unknown';
    try {
      const opts = admin.app().options || {};
      projectId = opts.projectId || 'unknown';
      databaseURL = opts.databaseURL || 'unknown';
    } catch (e) {}
    const dbProject = (databaseURL.match(/https:\/\/([^.]+)\.firebaseio\.com/) || [])[1] || 'unknown';
    const saRawEnv = process.env.FIREBASE_SERVICE_ACCOUNT || '';
    let saInfo = 'NO SERVICE ACCOUNT';
    if (saRawEnv) {
      try { const p = JSON.parse(saRawEnv); saInfo = { project_id: p.project_id || 'MISSING', client_email: p.client_email || 'MISSING' }; }
      catch (e1) { try { const p = JSON.parse(Buffer.from(saRawEnv, 'base64').toString('utf8')); saInfo = { project_id: p.project_id || 'MISSING', client_email: p.client_email || 'MISSING' }; } catch (e2) { saInfo = 'PARSE FAILED'; } }
    }
    res.json({
      serverProjectId: projectId,
      dbProjectId: dbProject,
      databaseURL: databaseURL,
      envProjectId: stripBOM(process.env.FIREBASE_PROJECT_ID || '') || 'NOT SET',
      envSenderId: stripBOM(process.env.FIREBASE_MESSAGING_SENDER_ID || '') || 'NOT SET',
      serviceAccount: saInfo
    });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});



/* ===================== File Upload (Word → Questions) ===================== */

app.post('/api/admin/upload-questions', requireAdmin, async (req, res) => {
  try {
    const { courseId, fileContent } = req.body;
    if (!fileContent) return res.status(400).json({ error: 'لا يوجد محتوى' });

    const lines = fileContent.split('\n').filter(l => l.trim());
    const questions = [];

    // Try TSV/CSV format (from Word table: question\topt1\topt2\topt3\topt4\tcorrect)
    if (lines.length > 1 && lines[0].includes('\t') && lines[0].split('\t').length >= 6) {
      var header = lines[0].split('\t');
      for (var i = 1; i < lines.length; i++) {
        var cols = lines[i].split('\t');
        if (cols.length < 6) continue;
        var qText = cols[0].trim();
        if (!qText) continue;
        var opts = [cols[1], cols[2], cols[3], cols[4]].map(function(o) {
          return o.replace(/^[أ-دأ-د\s]*[\.\-\)]\s*/, '').trim();
        });
        var correctLetter = cols[5].trim().charAt(0);
        var correctMap = { 'أ': 0, 'ا': 0, 'ب': 1, 'ج': 2, 'د': 3 };
        var correct = correctMap[correctLetter] !== undefined ? correctMap[correctLetter] : 0;
        questions.push({ question: qText, options: opts, correct: correct });
      }
      return res.json({ success: true, questions: questions });
    }

    // Try Word table format (mammoth extracts table cells as consecutive lines)
    if (lines.length >= 12 && lines.length % 6 === 0) {
      var firstRowCols = lines.slice(0, 6);
      var hasTableHeader = firstRowCols.some(function(c) { return /السؤال|الاجابة|الصحيحة/.test(c); });
      if (hasTableHeader) {
        for (var i = 6; i < lines.length; i += 6) {
          var qText = (lines[i] || '').trim();
          if (!qText) continue;
          var opts = [lines[i+1]||'', lines[i+2]||'', lines[i+3]||'', lines[i+4]||''].map(function(o) {
            return (o||'').replace(/^[أ-دأ-د\s]*[\.\-\)]\s*/, '').trim();
          });
          var correctLetter = (lines[i+5]||'').trim().charAt(0);
          var correctMap = { 'أ': 0, 'ا': 0, 'ب': 1, 'ج': 2, 'د': 3 };
          var correct = correctMap[correctLetter] !== undefined ? correctMap[correctLetter] : 0;
          questions.push({ question: qText, options: opts, correct: correct });
        }
        return res.json({ success: true, questions: questions });
      }
    }

    // Legacy format support
    let currentQ = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\d+[\.\-\)]/.test(trimmed)) {
        if (currentQ) questions.push(currentQ);
        currentQ = { question: trimmed.replace(/^\d+[\.\-\)]\s*/, ''), options: [], correct: 0 };
      } else if (/^[أ-دأ-د][\.\-\)]/.test(trimmed)) {
        if (currentQ) {
          const optText = trimmed.replace(/^[أ-دأ-د][\.\-\)]\s*/, '');
          currentQ.options.push(optText);
        }
      } else if (/^(صح|خطأ|✅|❌)/.test(trimmed)) {
        if (currentQ) {
          currentQ.type = 'true-false';
          currentQ.correct = trimmed.includes('صح') || trimmed.includes('✅') ? 0 : 1;
        }
      } else if (currentQ) {
        currentQ.question += ' ' + trimmed;
      }
    }
    if (currentQ) questions.push(currentQ);

    res.json({ success: true, questions });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.post('/api/admin/upload-word-file', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });
    const result = await mammoth.extractRawText({ buffer: req.file.buffer });
    const text = result.value;
    if (!text.trim()) return res.status(400).json({ error: 'لم يتم استخراج نص من الملف' });

    const lines = text.split('\n').filter(l => l.trim());
    const questions = [];

    // Try TSV/CSV format (from Word table: question\topt1\topt2\topt3\topt4\tcorrect\ttype)
    if (lines.length > 1 && lines[0].includes('\t') && lines[0].split('\t').length >= 6) {
      var header = lines[0].split('\t');
      for (var i = 1; i < lines.length; i++) {
        var cols = lines[i].split('\t');
        if (cols.length < 6) continue;
        var qText = cols[0].trim();
        if (!qText) continue;
        var isEssay = cols.length >= 7 && (cols[6].trim().toLowerCase() === 'essay' || cols[6].trim() === 'مقالي');
        if (isEssay) {
          var modelAnswer = cols[5] ? cols[5].trim() : '';
          questions.push({ question: qText, type: 'essay', modelAnswer: modelAnswer });
        } else {
          var opts = [cols[1], cols[2], cols[3], cols[4]].map(function(o) {
            return o.replace(/^[أ-دأ-د\s]*[\.\-\)]\s*/, '').trim();
          });
          var correctLetter = cols[5].trim().charAt(0);
          var correctMap = { 'أ': 0, 'ا': 0, 'ب': 1, 'ج': 2, 'د': 3 };
          var correct = correctMap[correctLetter] !== undefined ? correctMap[correctLetter] : 0;
          questions.push({ question: qText, options: opts, correct: correct, type: 'choice' });
        }
      }
      return res.json({ success: true, questions: questions });
    }

    // Try Word table format (mammoth extracts table cells as consecutive lines)
    if (lines.length >= 12 && lines.length % 7 === 0) {
      var firstRowCols = lines.slice(0, 7);
      var hasTableHeader = firstRowCols.some(function(c) { return /السؤال|الاجابة|الصحيحة|النوع|type/i.test(c); });
      if (hasTableHeader) {
        for (var i = 7; i < lines.length; i += 7) {
          var qText = (lines[i] || '').trim();
          if (!qText) continue;
          var isEssay = (lines[i+6] || '').trim().toLowerCase() === 'essay' || (lines[i+6] || '').trim() === 'مقالي';
          if (isEssay) {
            var modelAnswer = (lines[i+5] || '').trim();
            questions.push({ question: qText, type: 'essay', modelAnswer: modelAnswer });
          } else {
            var opts = [lines[i+1]||'', lines[i+2]||'', lines[i+3]||'', lines[i+4]||''].map(function(o) {
              return (o||'').replace(/^[أ-دأ-د\s]*[\.\-\)]\s*/, '').trim();
            });
            var correctLetter = (lines[i+5]||'').trim().charAt(0);
            var correctMap = { 'أ': 0, 'ا': 0, 'ب': 1, 'ج': 2, 'د': 3 };
            var correct = correctMap[correctLetter] !== undefined ? correctMap[correctLetter] : 0;
            questions.push({ question: qText, options: opts, correct: correct, type: 'choice' });
          }
        }
        return res.json({ success: true, questions: questions });
      }
    }

    // Legacy format support (backward compatible)
    let currentQ = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\d+[\.\-\)]/.test(trimmed)) {
        if (currentQ) questions.push(currentQ);
        currentQ = { question: trimmed.replace(/^\d+[\.\-\)]\s*/, ''), options: [], correct: 0 };
      } else if (/^[أ-دأ-د][\.\-\)]/.test(trimmed)) {
        if (currentQ) {
          const optText = trimmed.replace(/^[أ-دأ-د][\.\-\)]\s*/, '');
          currentQ.options.push(optText);
        }
      } else if (/^(صح|خطأ|✅|❌)/.test(trimmed)) {
        if (currentQ) {
          currentQ.type = 'true-false';
          currentQ.correct = trimmed.includes('صح') || trimmed.includes('✅') ? 0 : 1;
        }
      } else if (currentQ) {
        currentQ.question += ' ' + trimmed;
      }
    }
    if (currentQ) {
      if (currentQ.options.length > 0) {
        currentQ.type = 'choice';
      } else {
        currentQ.type = 'essay';
        currentQ.modelAnswer = currentQ.question; // fallback
        currentQ.question = currentQ.question;
      }
      questions.push(currentQ);
    }

    // Ensure all questions have type field
    questions.forEach(q => { if (!q.type) q.type = q.options && q.options.length > 0 ? 'choice' : 'essay'; });

    res.json({ success: true, questions });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.post('/api/admin/upload-note-file', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });
    var ext = path.extname(req.file.originalname) || '.pdf';
    var allowedExts = ['.pdf','.png','.jpg','.jpeg','.webp','.gif','.doc','.docx','.ppt','.pptx','.txt','.zip'];
    if (allowedExts.indexOf(ext.toLowerCase()) === -1) return res.status(400).json({ error: 'نوع الملف غير مسموح به' });

    if (storageConfig.isR2Enabled()) {
      const storage = getStorageService();
      const noteId = 'note-' + Date.now();
      const objectKey = storage.generateObjectKey('notes', noteId, 'file', req.file.originalname);
      await storage.upload({
        key: objectKey,
        body: req.file.buffer,
        contentType: req.file.mimetype || 'application/octet-stream',
        metadata: { originalName: req.file.originalname, uploadedBy: req.session.user ? (req.session.user.id || req.session.user.email) : 'admin' }
      });
      return res.json({ success: true, url: objectKey });
    }

    const path2 = await supabaseStorage.uploadPdf('notes', req.file.originalname, req.file.buffer, req.file.mimetype);
    res.json({ success: true, url: path2 });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN: Upload Comprehensive Exam (Word - Parse Only) ===================== */
app.post('/api/admin/upload-comprehensive-exam', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'يرجى اختيار ملف Word (.docx أو .doc)' });
    var ext = path.extname(req.file.originalname) || '.docx';
    var allowedExts = ['.doc','.docx'];
    if (allowedExts.indexOf(ext.toLowerCase()) === -1) return res.status(400).json({ error: 'نوع الملف غير مسموح — يجب أن يكون Word (.doc أو .docx)' });

    var parsedQuestions = [];
    try {
      var result = await mammoth.extractRawText({ buffer: req.file.buffer });
      var text = result.value;
      if (text.trim()) {
        var lines = text.split('\n').filter(function(l) { return l.trim(); });
        var questions = [];

        // Try TSV/CSV format (from Word table: question\topt1\topt2\topt3\topt4\tcorrect\ttype)
        if (lines.length > 1 && lines[0].includes('\t') && lines[0].split('\t').length >= 6) {
          for (var i = 1; i < lines.length; i++) {
            var cols = lines[i].split('\t');
            if (cols.length < 6) continue;
            var qText = cols[0].trim();
            if (!qText) continue;
            var isEssay = cols.length >= 7 && (cols[6].trim().toLowerCase() === 'essay' || cols[6].trim() === 'مقالي');
            if (isEssay) {
              var modelAnswer = cols[5] ? cols[5].trim() : '';
              questions.push({ question: qText, type: 'essay', modelAnswer: modelAnswer });
            } else {
              var opts = [cols[1], cols[2], cols[3], cols[4]].map(function(o) {
                return o.replace(/^[أ-دأ-د\s]*[\.\-\)]\s*/, '').trim();
              });
              var correctLetter = cols[5].trim().charAt(0);
              var correctMap = { 'أ': 0, 'ا': 0, 'ب': 1, 'ج': 2, 'د': 3 };
              var correct = correctMap[correctLetter] !== undefined ? correctMap[correctLetter] : 0;
              questions.push({ question: qText, options: opts, correct: correct, type: 'choice' });
            }
          }
          parsedQuestions = questions;
        } else {
          // Try Word table format (mammoth extracts table cells as consecutive lines)
          var headerIdx = -1;
          for (var hi = 0; hi < lines.length; hi++) {
            if (/السؤال|الإجابة|الصحيحة|النوع|type/i.test(lines[hi])) {
              headerIdx = hi;
              break;
            }
          }
          if (headerIdx !== -1) {
            var dataStart = headerIdx + 7;
            var dataLines = lines.slice(dataStart);
            for (var i = 0; i < dataLines.length; i += 7) {
              if (i + 6 >= dataLines.length) break;
              var qText = (dataLines[i] || '').trim();
              if (!qText) continue;
              var isEssay = (dataLines[i+6] || '').trim().toLowerCase() === 'essay' || (dataLines[i+6] || '').trim() === 'مقالي';
              if (isEssay) {
                var modelAnswer = (dataLines[i+5] || '').trim();
                questions.push({ question: qText, type: 'essay', modelAnswer: modelAnswer });
              } else {
                var opts = [dataLines[i+1]||'', dataLines[i+2]||'', dataLines[i+3]||'', dataLines[i+4]||''].map(function(o) {
                  return (o||'').replace(/^[أ-دأ-د\s]*[\.\-\)]\s*/, '').trim();
                });
                var correctLetter = (dataLines[i+5]||'').trim().charAt(0);
                var correctMap = { 'أ': 0, 'ا': 0, 'ب': 1, 'ج': 2, 'د': 3 };
                var correct = correctMap[correctLetter] !== undefined ? correctMap[correctLetter] : 0;
                questions.push({ question: qText, options: opts, correct: correct, type: 'choice' });
              }
            }
            parsedQuestions = questions;
          } else {
            // Legacy format support (backward compatible)
            var q = null;
            for (var i = 0; i < lines.length; i++) {
              var trimmed = lines[i].trim();
              if (/^\d+[\.\-\)]/.test(trimmed)) {
                if (q) parsedQuestions.push(q);
                q = { question: trimmed.replace(/^\d+[\.\-\)]\s*/, ''), options: [], correct: 0 };
              } else if (/^[أ-دأ-د][\.\-\)]/.test(trimmed)) {
                if (q) q.options.push(trimmed.replace(/^[أ-دأ-د][\.\-\)]\s*/, ''));
              } else if (/^(صح|خطأ|✅|❌)/.test(trimmed)) {
                if (q) { q.type = 'true-false'; q.correct = trimmed.includes('صح') || trimmed.includes('✅') ? 0 : 1; }
              } else if (q) {
                q.question += ' ' + trimmed;
              }
            }
            if (q) parsedQuestions.push(q);
          }
        }
        parsedQuestions.forEach(function(qq) {
          if (!qq.type) qq.type = (qq.options && qq.options.length > 0) ? 'choice' : 'essay';
          if (qq.type === 'choice' && qq.correct === undefined) qq.correct = 0;
        });
      }
    } catch(e) {
      console.error('[comprehensive-exam parse] error:', e.message);
    }

    // Store the file buffer temporarily for the save step
    var tempKey = 'temp-exam-' + Date.now();
    var objectKey = '';

    if (storageConfig.isR2Enabled()) {
      const storage = getStorageService();
      objectKey = storage.generateObjectKey('comprehensive-exam', tempKey, 'exam', req.file.originalname);
      await storage.upload({
        key: objectKey,
        body: req.file.buffer,
        contentType: req.file.mimetype || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        metadata: { originalName: req.file.originalname, uploadedBy: req.session.user ? (req.session.user.id || req.session.user.email) : 'admin', uploadedAt: new Date().toISOString(), temp: 'true' }
      });
    } else {
      objectKey = await supabaseStorage.uploadPdf('comprehensive-exam', req.file.originalname, req.file.buffer, req.file.mimetype || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    }

    // Return parsed questions for editing (don't save final exam yet)
    res.json({
      success: true,
      questions: parsedQuestions,
      fileName: req.file.originalname,
      tempKey: tempKey,
      tempPath: objectKey
    });
  } catch (e) {
    console.error('[comprehensive-exam upload] error:', e && e.message);
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN: Save Comprehensive Exam (after editing) ===================== */
app.post('/api/admin/save-comprehensive-exam', requireAdmin, async (req, res) => {
  try {
    const { title, timeMinutes, passPercentage, enabled, questions, fileName, tempPath } = req.body;
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'لا توجد أسئلة لحفظها' });
    }

    const examId = 'exam-' + Date.now();
    const examData = {
      id: examId,
      title: title || 'اختبار شامل المنهج',
      fileName: fileName || 'comprehensive-exam.docx',
      filePath: tempPath || '',
      questions: questions,
      timeSettings: { minutes: parseInt(timeMinutes) || 30 },
      passPercentage: parseInt(passPercentage) || 60,
      enabled: enabled !== false,
      uploadedBy: req.session.user ? req.session.user.name : 'admin',
      createdAt: new Date().toISOString()
    };

    await writeData('comprehensiveExam', examData);

    // Clean up temp file if it exists
    if (examData.filePath && storageConfig.isR2Enabled()) {
      // Keep the file - it's now the permanent file
    }

    res.json({ success: true, exam: { id: examData.id, title: examData.title, questionCount: questions.length, createdAt: examData.createdAt } });
  } catch (e) {
    console.error('[comprehensive-exam save] error:', e && e.message);
    res.status(500).json({ error: 'تعذر حفظ الاختبار، حاول مرة أخرى.' });
  }
});

/* ===================== CONTACT FORM ===================== */

app.post('/api/contact', async (req, res) => {
  try {
    const { name, phone, email, message } = req.body;
    if (!name || !phone || !message) return res.status(400).json({ error: 'يرجى ملء جميع الحقول المطلوبة' });
    const contacts = await readData('contacts') || [];
    contacts.push({ id: Date.now().toString(), name, phone, email: email || '', message, date: new Date().toISOString(), read: false });
    await writeData('contacts', contacts);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== REFERRAL ===================== */

app.get('/api/student/referral', requireAuth, async (req, res) => {
  try {
    var prisma = getPrisma();
    const user = await prisma.user.findUnique({ where: { id: req.session.user.id }, select: { referralCode: true, referrals: true } });
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json({ success: true, referralCode: user.referralCode, referrals: user.referrals || [] });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== MIGRATION: Attach stage/grade to existing reviews ===================== */
(async function() {
  try {
    var reviews = await readData('reviews');
    var changed = false;
    reviews.forEach(function(r) {
      if (!r.stage) { r.stage = 'ثانوية'; changed = true; }
      if (!r.grade) { r.grade = 'الثالث الثانوي'; changed = true; }
    });
    if (changed) await writeData('reviews', reviews);
  } catch (e) { /* silent */ }
})();

/* ===================== Zoom OAuth Routes ===================== */

// GET /auth/zoom — Redirect teacher to Zoom OAuth authorization page
app.get('/auth/zoom', requireAdmin, (req, res) => {
  if (!zoom.isConfigured()) {
    return res.send('<html dir="rtl"><head><meta charset="utf-8"><title>Zoom - الإعدادات</title><style>body{font-family:Cairo,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0F172A;color:#fff;direction:rtl;text-align:center;padding:20px;}div{max-width:400px;}.btn{display:inline-block;margin-top:16px;padding:10px 24px;background:#F59E0B;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;}</style></head><body><div><h2>⚙️ لم يتم تكوين Zoom</h2><p style="color:#94a3b8;font-size:14px;">يرجى ضبط المتغيرات البيئية التالية في Vercel:</p><p style="background:#1E293B;padding:12px;border-radius:8px;font-size:12px;font-family:monospace;text-align:left;direction:ltr;">ZOOM_CLIENT_ID<br>ZOOM_CLIENT_SECRET<br>ZOOM_REDIRECT_URI</p><a href="/admin/settings" class="btn">← العودة للإعدادات</a></div></body></html>');
  }
  var state = crypto.randomBytes(16).toString('hex');
  if (req.session) req.session.zoomOAuthState = state;
  console.error('ZOOM AUTH DEBUG set state=', state, 'sessionExists=', !!req.session, 'cookieHeader=', (req.headers && req.headers.cookie) ? 'present' : 'missing');
  var proto = (req.headers && req.headers['x-forwarded-proto']) || req.protocol || 'https';
  if (proto.indexOf(',') !== -1) proto = proto.split(',')[0].trim();
  var host = (req.headers && req.headers['x-forwarded-host']) || req.get('host');
  if (host.indexOf(',') !== -1) host = host.split(',')[0].trim();
  var redirectUri = proto + '://' + host + '/auth/zoom/callback';
  var url = zoom.getAuthorizeUrl(state, redirectUri);
  res.redirect(url);
});

// GET /auth/zoom/callback — Handle Zoom OAuth callback
app.get('/auth/zoom/callback', async (req, res) => {
  try {
    var error = req.query.error;
    var state = req.query.state;
    var code = req.query.code;
    
    console.error('ZOOM CB DEBUG sessionExists=', !!req.session, 'hasState=', !!(req.session && req.session.zoomOAuthState), 'queryState=', state, 'cookieHeader=', (req.headers && req.headers.cookie) ? 'present' : 'missing');
    if (!req.session || !req.session.zoomOAuthState || state !== req.session.zoomOAuthState) {
      if (req.session) delete req.session.zoomOAuthState;
      return res.status(403).send('طلب غير مصرح به');
    }
    delete req.session.zoomOAuthState;
    
    if (error) return res.status(400).send('تم رفض الإذن من Zoom');
    if (!code) return res.status(400).send('رمز الترخيص مفقود');

    var uid = (req.session && req.session.user && req.session.user.id) || 'global';
    var proto = (req.headers && req.headers['x-forwarded-proto']) || req.protocol || 'https';
    if (proto.indexOf(',') !== -1) proto = proto.split(',')[0].trim();
    var host = (req.headers && req.headers['x-forwarded-host']) || req.get('host');
    if (host.indexOf(',') !== -1) host = host.split(',')[0].trim();
    var callbackRedirectUri = proto + '://' + host + '/auth/zoom/callback';
    await zoom.completeOAuth(uid, code, callbackRedirectUri);
    res.redirect('/admin/settings?zoom=connected');
  } catch (e) {
    console.error('Zoom OAuth callback error:', e.message);
    res.status(500).send(safeErr(e, 'فشل ربط حساب Zoom'));
  }
});

// GET /api/zoom/debug — Check token scopes (diagnostic, requires admin or CRON_SECRET)
app.get('/api/zoom/debug', async (req, res) => {
  var cronSecret = process.env.CRON_SECRET || '';
  if (req.query.secret !== cronSecret && !(req.session && req.session.user && req.session.user.role === 'admin')) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    var uid = (req.query.userId || req.session?.user?.id || '').trim() || 'global';
    var tokens = await zoom.loadTokens(uid);
    if (!tokens) return res.json({ error: 'لا يوجد توكين', uid: uid });
    var tokenInfo = null;
    try {
      var https = require('https');
      var info = await new Promise(function(resolve, reject) {
        var r = https.request({ hostname: 'api.zoom.us', path: '/oauth/tokeninfo', method: 'GET', headers: { 'Authorization': 'Bearer ' + tokens.accessToken } }, function(resp) { var d = ''; resp.on('data', function(c){ d += c; }); resp.on('end', function(){ resolve({ status: resp.statusCode, data: d }); }); });
        r.on('error', reject); r.end();
      });
      tokenInfo = JSON.parse(info.data);
    } catch(e) { tokenInfo = { error: e.message }; }
    res.json({ uid, tokenEncrypted: !!tokens, connectedAt: tokens.connectedAt, userName: tokens.userName, tokenInfo });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});
// GET /api/zoom/creds-check — Verify credentials are loaded correctly
app.get('/api/zoom/creds-check', async (req, res) => {
  var cronSecret = process.env.CRON_SECRET || '';
  if (req.query.secret !== cronSecret && !(req.session && req.session.user && req.session.user.role === 'admin')) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  var cid = process.env.ZOOM_CLIENT_ID || '';
  var csec = process.env.ZOOM_CLIENT_SECRET || '';
  var ruri = process.env.ZOOM_REDIRECT_URI || '';
  var testSig = zoom.generateSignature('123456789', 0);
  res.json({
    clientIdPrefix: cid.substring(0, 6) + '…',
    clientIdLength: cid.length,
    clientSecretPrefix: csec.substring(0, 4) + '…',
    clientSecretLength: csec.length,
    redirectUri: ruri,
    hasFirebaseCreds: !!(await zoom.readData && await zoom.readData('zoomAppCredentials')),
    testSignaturePrefix: testSig.substring(0, 20) + '…',
    testSignatureLength: testSig.length,
    isConfigured: zoom.isConfigured()
  });
});

app.post('/auth/zoom/disconnect', requireAdmin, async (req, res) => {
  try {
    var uid = (req.session && req.session.user && req.session.user.id) || 'global';
    await zoom.disconnect(uid);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// GET /auth/zoom/reauthorize — Disconnect then redirect to Zoom OAuth (single step)
app.get('/auth/zoom/reauthorize', requireAdmin, async (req, res) => {
  try {
    var uid = (req.session && req.session.user && req.session.user.id) || 'global';
    await zoom.disconnect(uid);
    console.error('ZOOM REAUTH: tokens cleared for', uid);
  } catch (e) {
    console.error('ZOOM REAUTH disconnect error (ignored):', e.message);
  }
  // Now redirect to the standard /auth/zoom route
  res.redirect('/auth/zoom');
});

// GET /api/zoom/status — Get Zoom connection status
app.get('/api/zoom/status', requireAdmin, async (req, res) => {
  try {
    var configured = zoom.isConfigured();
    if (!configured) return res.json({ connected: false, configured: false });
    var uid = (req.session && req.session.user && req.session.user.id) || 'global';
    var status = await zoom.getStatus(uid);
    res.json({ ...status, configured: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر التحقق من حالة Zoom', connected: false, configured: zoom.isConfigured() });
  }
});

// GET /api/zoom/profile — Get Zoom user profile
app.get('/api/zoom/profile', requireAdmin, async (req, res) => {
  try {
    var uid = (req.session && req.session.user && req.session.user.id) || 'global';
    var status = await zoom.getStatus(uid);
    if (!status.connected) return res.json({ connected: false });
    res.json({ connected: true, userName: status.userName, userEmail: status.userEmail, userAvatar: status.userAvatar, connectedAt: status.connectedAt });
  } catch (e) {
    res.status(500).json({ connected: false, error: 'تعذر جلب بيانات حساب Zoom' });
  }
});

/* ===================== END Zoom OAuth Routes ===================== */

/* ===================== Live Sessions API & Pages ===================== */

// GET /admin/live-sessions is defined above with admin page routes

// GET /student/live-session/:id — Join a live session
app.get('/student/live-session/:id', requireStudentOrGuest, async (req, res) => {
  try {
    var sessions = await readData('liveSessions') || [];
    var session = sessions.find(function(s) { return s.id === req.params.id; });
    if (!session) return res.status(404).send('الحصة غير موجودة');
    var zoomSignature = '';
    if (session.meetingId && zoom.isConfigured()) {
      try { zoomSignature = await zoom.generateSignatureAsync(session.meetingId, 0); } catch(e) {}
    }
    res.render('student/live-session', {
      session: session,
      title: session.title + ' - حصة مباشرة',
      isGuest: req.session.demoMode,
      user: req.session.user,
      zoomSignature: zoomSignature,
      sdkKey: process.env.ZOOM_CLIENT_ID || ''
    });
  } catch(e) {
    console.error('[live-session page] error:', e.message, e.stack);
    res.status(500).send('خطأ في تحميل الحصة');
  }
});

// GET /zoom-embed/:id — Clean Zoom Meeting SDK page (no site CSS, embedded in iframe)
app.get('/zoom-embed/:id', requireStudentOrGuest, async (req, res) => {
  try {
    var sessions = await readData('liveSessions') || [];
    var session = sessions.find(function(s) { return s.id === req.params.id; });
    if (!session) return res.status(404).send('الحصة غير موجودة');
    var zoomSignature = '';
    var embedSdkKey = process.env.ZOOM_SDK_KEY || process.env.ZOOM_CLIENT_ID || '';
    if (session.meetingId && zoom.isConfigured()) {
      var embedCreds = await zoom.getStoredCredentials();
      embedSdkKey = embedCreds ? (embedCreds.sdkKey || embedCreds.clientId) : embedSdkKey;
      try { zoomSignature = await zoom.generateSignatureAsync(session.meetingId, 0); } catch(e) {}
    }
    // Override CSP + XFO to allow same-origin iframe embedding
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Content-Security-Policy',
      "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://source.zoom.us https://*.zoom.us https://zoom.us https://*.firebaseio.com; " +
      "style-src 'self' 'unsafe-inline' https://source.zoom.us https://*.zoom.us https://zoom.us; " +
      "img-src * data: blob:; " +
      "media-src * blob:; " +
      "connect-src * wss: blob:; " +
      "worker-src * blob:; child-src * blob:; " +
      "frame-src *; frame-ancestors 'self' https://almumayaz.vercel.app; " +
      "object-src 'none'; base-uri 'self'");
    res.setHeader('Permissions-Policy', 'camera=*, microphone=*, display-capture=*');
    var userRole = (req.session.user && req.session.user.role) || '';
    res.render('zoom-embed', {
      session: session,
      zoomSignature: zoomSignature,
      sdkKey: embedSdkKey,
      userName: (req.session.user && req.session.user.name) || 'زائر',
      userEmail: (req.session.user && req.session.user.email) || '',
      isStudent: userRole === 'student'
    });
  } catch(e) {
    console.error('[zoom-embed] error:', e.message);
    res.status(500).send('Error');
  }
});

// GET /api/admin/live-sessions — List all live sessions (admin)
app.get('/api/admin/live-sessions', requireAdmin, async (req, res) => {
  try {
    var list = await readData('liveSessions') || [];
    // Migrate from Firestore if Prisma is empty and Firebase has data
    if (list.length === 0) {
      try {
        const fb = require('./prisma-bridge');
        if (fb.fbRead) {
          const fbSessions = await fb.fbRead('liveSessions');
          if (fbSessions && Array.isArray(fbSessions) && fbSessions.length > 0) {
            await writeData('liveSessions', fbSessions.map(function(s) {
              if (s.startTime && typeof s.startTime === 'number') s.startTime = new Date(s.startTime);
              if (s.notifyAt && typeof s.notifyAt === 'number') s.notifyAt = new Date(s.notifyAt);
              if (s.endTime && typeof s.endTime === 'number') s.endTime = new Date(s.endTime);
              if (s.createdAt && typeof s.createdAt === 'number') s.createdAt = new Date(s.createdAt);
              if (s.updatedAt && typeof s.updatedAt === 'number') s.updatedAt = new Date(s.updatedAt);
              return s;
            }));
            list = await readData('liveSessions') || [];
          }
        }
      } catch(me) { console.error('[live migration]', me.message); }
    }
    res.json(list);
  } catch(e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// POST /api/admin/live-sessions — Create a new live session (creates Zoom meeting via teacher's account)
app.post('/api/admin/live-sessions', requireAdmin, async (req, res) => {
  try {
    var { title, subject, grade, stage, startTime, duration, password, notifyAt, allowJoinBeforeTeacher, waitingRoom, recording } = req.body;
    if (!title || !startTime) return res.status(400).json({ error: 'عنوان الحصة ووقت البداية مطلوبان' });

    // Try to create Zoom meeting if configured
    var zoomResult = null;
    if (zoom.isConfigured()) {
      var uid = (req.session && req.session.user && req.session.user.id) || 'global';
      var status = await zoom.getStatus(uid);
      if (!status.connected) {
        return res.status(400).json({ error: 'يجب ربط حساب Zoom أولاً من صفحة الإعدادات.' });
      }
      try {
        zoomResult = await zoom.createMeeting(uid, {
          title: title,
          startTime: startTime,
          duration: parseInt(duration) || 60,
          password: password || '',
          allowJoinBeforeTeacher: !!allowJoinBeforeTeacher,
          waitingRoom: !!waitingRoom,
          recording: !!recording
        });
      } catch (ze) {
        return res.status(500).json({ error: safeErr(ze, 'فشل إنشاء اجتماع Zoom') });
      }
    }

    var sessions = await readData('liveSessions') || [];
    var newSession = {
      id: Date.now().toString(),
      title: title,
      subject: subject || '',
      grade: grade || '',
      stage: stage || '',
      meetingId: zoomResult ? zoomResult.meetingId : '',
      joinUrl: zoomResult ? zoomResult.joinUrl : '',
      startUrl: zoomResult ? zoomResult.startUrl : '',
      password: zoomResult ? zoomResult.password : (password || ''),
      startTime: startTime,
      duration: parseInt(duration) || 60,
      notifyAt: notifyAt || null,
      notified: false,
      allowJoinBeforeTeacher: !!allowJoinBeforeTeacher,
      waitingRoom: !!waitingRoom,
      recording: !!recording,
      status: 'Scheduled',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: req.session.user ? req.session.user.id || req.session.user.uid : ''
    };
    sessions.push(newSession);
    await writeData('liveSessions', sessions);
    console.log('[create] session saved. total:', sessions.length, 'id:', newSession.id, 'grade:', newSession.grade, 'stage:', newSession.stage);
    res.json({ success: true, session: newSession });
  } catch(e) {
    console.error('[create] error:', e.message);
    res.status(500).json({ error: 'تعذر إنشاء الحصة، حاول مرة أخرى.' });
  }
});

// PUT /api/admin/live-sessions/:id — Update a live session
app.put('/api/admin/live-sessions/:id', requireAdmin, async (req, res) => {
  try {
    var sessions = await readData('liveSessions') || [];
    var idx = sessions.findIndex(function(s) { return s.id === req.params.id; });
    if (idx === -1) return res.status(404).json({ error: 'الحصة غير موجودة' });
    var allowed = ['title','subject','grade','stage','startTime','duration','password','notifyAt','allowJoinBeforeTeacher','waitingRoom','recording'];
    var oldNotifyAt = sessions[idx].notifyAt;
    for (var k in req.body) {
      if (allowed.indexOf(k) !== -1) sessions[idx][k] = req.body[k];
    }
    if (sessions[idx].notifyAt !== oldNotifyAt) sessions[idx].notified = false;
    sessions[idx].updatedAt = new Date().toISOString();
    await writeData('liveSessions', sessions);
    console.log('[PUT] session', req.params.id, 'startTime:', sessions[idx].startTime, 'notifyAt:', sessions[idx].notifyAt);
    res.json({ success: true, session: sessions[idx] });
  } catch(e) {
    res.status(500).json({ error: 'تعذر تحديث الحصة، حاول مرة أخرى.' });
  }
});

// DELETE /api/admin/live-sessions/:id — Delete a live session
app.delete('/api/admin/live-sessions/:id', requireAdmin, async (req, res) => {
  try {
    var sessions = await readData('liveSessions') || [];
    var idx = sessions.findIndex(function(s) { return s.id === req.params.id; });
    if (idx === -1) return res.status(404).json({ error: 'الحصة غير موجودة' });
    sessions.splice(idx, 1);
    await writeData('liveSessions', sessions);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'تعذر حذف الحصة، حاول مرة أخرى.' });
  }
});

// POST /api/admin/live-sessions/:id/start — Start a live session
app.post('/api/admin/live-sessions/:id/start', requireAdmin, async (req, res) => {
  try {
    var sessions = await readData('liveSessions') || [];
    var idx = sessions.findIndex(function(s) { return s.id === req.params.id; });
    if (idx === -1) return res.status(404).json({ error: 'الحصة غير موجودة' });
    if (sessions[idx].status !== 'Scheduled') return res.status(400).json({ error: 'يمكن بدء الحصص المجدولة فقط' });
    sessions[idx].status = 'Live';
    sessions[idx].updatedAt = new Date().toISOString();
    await writeData('liveSessions', sessions);

    // Send push notification to students matching this session's grade/stage
    try {
      var prisma = getPrisma();
      var stageMap = { 'إعدادي': 'إعدادية', 'ثانوي': 'ثانوية' };
      var s = sessions[idx];
      var where = { role: 'student', deletedAt: null, NOT: { fcmToken: '' } };
      if (s.grade) where.grade = s.grade;
      else if (s.stage) where.stage = stageMap[s.stage] || s.stage;
      var recipients = await prisma.user.findMany({ where, select: { id: true } });
      var startSent = 0;
      for (var ri = 0; ri < recipients.length; ri++) {
        var ok = await sendFCM(recipients[ri].id, '📺 الحصة المباشرة بدأت الآن!', (s.title || 'حصة مباشرة') + ' - اضغط للانضمام', '/student/live-session/' + s.id);
        if (ok) { sessionSent++; startSent++; }
      }
      if (startSent > 0) {
        sessions[idx].notified = true;
        await writeData('liveSessions', sessions);
      }
    } catch (notifErr) {
      console.error('[start] notification error:', notifErr.message);
    }

    res.json({ success: true, session: sessions[idx] });
  } catch(e) {
    res.status(500).json({ error: 'تعذر بدء الحصة، حاول مرة أخرى.' });
  }
});

// POST /api/admin/live-sessions/:id/end — End a live session
app.post('/api/admin/live-sessions/:id/end', requireAdmin, async (req, res) => {
  try {
    var sessions = await readData('liveSessions') || [];
    var idx = sessions.findIndex(function(s) { return s.id === req.params.id; });
    if (idx === -1) return res.status(404).json({ error: 'الحصة غير موجودة' });
    if (sessions[idx].status !== 'Live') return res.status(400).json({ error: 'يمكن إنهاء الحصص المباشرة فقط' });

    // End Zoom meeting if we have a meetingId (uses teacher's linked account)
    if (sessions[idx].meetingId && zoom.isConfigured()) {
      try {
        var ownerId = sessions[idx].createdBy || (req.session && req.session.user && req.session.user.id) || 'global';
        await zoom.endMeeting(ownerId, sessions[idx].meetingId);
      } catch (ze) {
        console.error('Zoom end meeting failed:', ze.message);
        return res.status(500).json({ error: safeErr(ze, 'تعذر إنهاء اجتماع Zoom') });
      }
    }

    sessions[idx].status = 'Ended';
    sessions[idx].updatedAt = new Date().toISOString();
    await writeData('liveSessions', sessions);
    res.json({ success: true, session: sessions[idx] });
  } catch(e) {
    res.status(500).json({ error: 'تعذر إنهاء الحصة، حاول مرة أخرى.' });
  }
});

// POST /api/admin/live-sessions/:id/cancel — Cancel a live session
app.post('/api/admin/live-sessions/:id/cancel', requireAdmin, async (req, res) => {
  try {
    var sessions = await readData('liveSessions') || [];
    var idx = sessions.findIndex(function(s) { return s.id === req.params.id; });
    if (idx === -1) return res.status(404).json({ error: 'الحصة غير موجودة' });
    sessions[idx].status = 'Cancelled';
    sessions[idx].updatedAt = new Date().toISOString();
    await writeData('liveSessions', sessions);
    res.json({ success: true, session: sessions[idx] });
  } catch(e) {
    res.status(500).json({ error: 'تعذر إلغاء الحصة، حاول مرة أخرى.' });
  }
});

// GET /debug/sessions — Debug: show all raw sessions (admin)
app.get('/api/debug/sessions', requireAdmin, async (req, res) => {
  try {
    var sessions = await readData('liveSessions') || [];
    var fbData = null;
    if (admin && admin.database) {
      try {
        var snap = await admin.database().ref('liveSessions').once('value');
        fbData = snap.val();
      } catch(e) { fbData = 'FIREBASE_READ_ERROR: ' + e.message; }
    } else {
      fbData = 'fbDb not available';
    }
    res.json({
      readDataResult: { count: sessions.length, sessions: sessions },
      firebaseRaw: fbData,
      fbDbAvailable: !!(admin && admin.database)
    });
  } catch(e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// GET /api/debug/student-sessions — Debug endpoint for admin
app.get('/api/debug/student-sessions', requireAdmin, async (req, res) => {
  try {
    var sessions = await readData('liveSessions') || [];
    var user = req.session.user;
    var fbData = null;
    if (admin && admin.database) {
      try {
        var snap = await admin.database().ref('liveSessions').once('value');
        fbData = Array.isArray(snap.val()) ? snap.val().length : (snap.val() ? Object.keys(snap.val()).length : 0);
      } catch(e) { fbData = 'FIREBASE_READ_ERROR: ' + e.message; }
    } else {
      fbData = 'fbDb not available';
    }
    res.json({
      sessionUser: user ? { id: user.id, role: user.role, grade: user.grade, stage: user.stage, name: user.name } : null,
      readDataCount: sessions ? sessions.length : 0,
      readDataFirst: sessions && sessions.length > 0 ? sessions[0] : null,
      firebaseInfo: fbData
    });
  } catch(e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// GET /api/live-sessions/upcoming — Get upcoming sessions for student (filtered by grade)
app.get('/api/live-sessions/upcoming', requireStudentOrGuest, async (req, res) => {
  try {
    var user = req.session.user;
    var sessions = await readData('liveSessions') || [];
    var userGrade = (user && user.grade) || '';
    var userStage = (user && user.stage) || '';
    var filtered = sessions.filter(function(s) {
      if (s.status !== 'Scheduled' && s.status !== 'Live') return false;
      if (userGrade && s.grade && normGrade(s.grade) !== normGrade(userGrade)) return false;
      if (userStage && s.stage && normStage(s.stage) !== normStage(userStage)) return false;
      return true;
    });
    filtered.sort(function(a, b) { return new Date(a.startTime) - new Date(b.startTime); });
    res.json({ sessions: filtered, total: sessions.length, userGrade: userGrade, userStage: userStage });
  } catch(e) {
    res.status(500).json({ error: safeErr(e), sessions: [], total: 0 });
  }
});

// GET /api/live-sessions/:id — Get a single live session details
app.get('/api/live-sessions/:id', requireStudentOrGuest, async (req, res) => {
  try {
    var sessions = await readData('liveSessions') || [];
    var session = sessions.find(function(s) { return s.id === req.params.id; });
    if (!session) return res.status(404).json({ error: 'الحصة غير موجودة' });
    var creds = await zoom.getStoredCredentials();
    var cid = creds ? creds.clientId : (process.env.ZOOM_CLIENT_ID || '');
    // Generate signature for Zoom Meeting SDK
    var signature = '';
    var sdkKey = cid;
    if (session.meetingId && zoom.isConfigured()) {
      try {
        signature = await zoom.generateSignatureAsync(session.meetingId, 0);
      } catch(e) {}
    }
    res.json({ session: session, signature: signature, sdkKey: sdkKey });
  } catch(e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// POST /api/live-sessions/:id/attendance — Record attendance (join/leave)
app.post('/api/live-sessions/:id/attendance', requireStudentOrGuest, async (req, res) => {
  try {
    var userId = req.session.user ? (req.session.user.id || req.session.user.uid) : 'guest';
    var { action } = req.body; // 'join' or 'leave'
    if (!action) return res.status(400).json({ error: 'action مطلوب' });
    if (!/^[a-zA-Z0-9_\-]+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
    var path = 'liveSessionAttendance/' + req.params.id + '/' + userId;
    var existing = await admin.database().ref(path).once('value').then(function(s) { return s.val(); }).catch(function() { return null; });

    if (action === 'join') {
      if (existing && existing.joinedAt && !existing.leftAt) {
        return res.json({ success: true, attendance: existing });
      }
      var record = { joinedAt: new Date().toISOString(), leftAt: null, duration: 0 };
      await admin.database().ref(path).set(record);
      res.json({ success: true, attendance: record });
    } else if (action === 'leave') {
      if (!existing || !existing.joinedAt) return res.json({ success: true });
      var leftAt = new Date().toISOString();
      var duration = Math.round((new Date(leftAt).getTime() - new Date(existing.joinedAt).getTime()) / 1000);
      var record = { joinedAt: existing.joinedAt, leftAt: leftAt, duration: duration };
      await admin.database().ref(path).set(record);
      res.json({ success: true, attendance: record });
    } else {
      res.status(400).json({ error: 'action غير صالح' });
    }
  } catch(e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// GET /api/admin/live-sessions/:id/attendance — Get attendance for a session
app.get('/api/admin/live-sessions/:id/attendance', requireAdmin, async (req, res) => {
  try {
    var snap = await admin.database().ref('liveSessionAttendance/' + req.params.id).once('value');
    var val = snap.val() || {};
    var prisma = getPrisma();
    var userIds = Object.keys(val);
    var users = await prisma.user.findMany({ where: { OR: userIds.map(function(uid) { return { id: uid }; }) }, select: { id: true, name: true } });
    var userMap = {};
    users.forEach(function(u) { userMap[u.id] = u; });
    var list = userIds.map(function(uid) {
      var u = userMap[uid];
      return {
        userId: uid,
        userName: u ? u.name : 'مستخدم',
        joinedAt: val[uid].joinedAt || '',
        leftAt: val[uid].leftAt || '',
        duration: val[uid].duration || 0
      };
    });
    res.json(list);
  } catch(e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

/* ===================== END Live Sessions API ===================== */
(async function() {
  if (!supabaseStorage.isConfigured()) {
    console.warn('[supabase-storage] Supabase env vars not set - PDF uploads disabled until SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are added.');
    return;
  }
  try {
    await supabaseStorage.ensureBucket();
  } catch (e) {
    console.error('[supabase-storage] bucket init error:', e.message);
  }
})();

// GET /api/cron/check-notifications — Cron job: send scheduled notifications
app.get('/api/cron/check-notifications', async (req, res) => {
  if (!process.env.CRON_SECRET || req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    if (!admin.messaging) {
      console.error('[cron] admin.messaging is NOT available');
      return res.json({ success: false, sent: 0, error: 'FCM not available' });
    }
    var prisma = getPrisma();
    var sessions = await readData('liveSessions') || [];
    var stageMap = { 'إعدادي': 'إعدادية', 'ثانوي': 'ثانوية' };
    var now = new Date().toISOString();
    var sent = 0;
    for (var si = 0; si < sessions.length; si++) {
      var s = sessions[si];
      if (!s.notifyAt || s.notified) {
        console.log('[cron] skip session ' + s.id + ': notifyAt=' + (s.notifyAt||'none') + ' notified=' + s.notified);
        continue;
      }
      if (s.notifyAt > now) { console.log('[cron] session ' + s.id + ' notifyAt in future'); continue; }
      if (s.status !== 'Scheduled') { console.log('[cron] session ' + s.id + ' status=' + s.status); continue; }
      var recipients = [];
      var whereStudent = { role: 'student', deletedAt: null, NOT: { fcmToken: '' } };
      if (s.grade) whereStudent.grade = s.grade;
      else if (s.stage) whereStudent.stage = stageMap[s.stage] || s.stage;
      recipients = await prisma.user.findMany({ where: whereStudent, select: { id: true } });
      console.log('[cron] session ' + s.id + ' found ' + recipients.length + ' recipients');
      if (recipients.length === 0) continue;
      // Atomic lock via Firebase to prevent duplicate sends from concurrent requests
      try {
        var claimRef = admin.database().ref('_cronClaims/' + s.id);
        var claimed = await claimRef.transaction(function(current) {
          if (current && (Date.now() - current < 120000)) return; // lock active (<2min)
          return Date.now();
        });
        if (!claimed.committed) continue; // another instance already claimed this session
      } catch (lockErr) {
        console.error('[cron] lock error:', lockErr.message);
        continue;
      }
      // Re-read liveSessions from Firebase to check if notified was already set (prevents race where stale data shows notified=false)
      try {
        var freshSnap2 = await admin.database().ref('liveSessions').once('value');
        var freshSessions2 = freshSnap2.val();
        if (Array.isArray(freshSessions2)) {
          var alreadyNotified = freshSessions2.some(function(fs) { return fs && fs.id === s.id && fs.notified; });
        } else if (freshSessions2 && typeof freshSessions2 === 'object') {
          var keys = Object.keys(freshSessions2);
          alreadyNotified = keys.some(function(k) {
            var fs = freshSessions2[k];
            return fs && fs.id === s.id && fs.notified;
          });
        }
        if (alreadyNotified) {
          claimRef.remove().catch(function(){});
          continue;
        }
      } catch (e) {
        console.error('[cron] re-read error:', e.message);
      }
      var sessionSent = 0;
      for (var ri = 0; ri < recipients.length; ri++) {
        var ok = await sendFCM(recipients[ri].id, '🔔 الحصة المباشرة على وشك البدء', (s.title || 'حصة مباشرة') + ' ستبدأ قريباً - اضغط للانضمام!', '/student/live-session/' + s.id);
        if (ok) sessionSent++;
      }
      if (sessionSent > 0) {
        s.notified = true;
        sent += sessionSent;
        var allNotifs = await readData('notifications') || [];
        allNotifs.push({
          id: 'live-remind-' + s.id + '-' + Date.now(),
          title: '🔔 الحصة المباشرة على وشك البدء',
          body: (s.title || 'حصة مباشرة') + ' ستبدأ قريباً - اضغط للانضمام!',
          target: s.grade ? 'grade' : 'stage',
          targetValue: s.grade || (stageMap[s.stage] || s.stage),
          sentAt: new Date().toISOString(),
          type: 'live_session_reminder',
          sessionId: s.id,
          sessionTitle: s.title
        });
        await writeData('notifications', allNotifs);
      }
    }
    if (sent > 0) {
      await writeData('liveSessions', sessions);
    }
    // Release locks AFTER all writes are persisted
    for (var si2 = 0; si2 < sessions.length; si2++) {
      if (sessions[si2].notified) {
        admin.database().ref('_cronClaims/' + sessions[si2].id).remove().catch(function(){});
      }
    }
    console.log('[cron] sent', sent, 'notifications, checked', sessions.length, 'sessions');
    res.json({ success: true, sent: sent });
  } catch (e) {
    console.error('[cron] error:', e.message);
    res.status(500).json({ error: safeErr(e) });
  }
});

// Debug endpoint to inspect sessions
app.get('/api/debug/notifications', requireAdmin, async (req, res) => {
  try {
    var prisma = getPrisma();
    var sessions = await readData('liveSessions') || [];
    var allStudents = await prisma.user.findMany({ where: { role: 'student', deletedAt: null }, select: { id: true, grade: true, stage: true, fcmToken: true } });
    var now = new Date().toISOString();
    var stageMap = { 'إعدادي': 'إعدادية', 'ثانوي': 'ثانوية' };
    var info = sessions.map(function(s) {
      var shouldNotify = !!(s.notifyAt && !s.notified && s.notifyAt <= now);
      var recipients = [];
      if (s.grade) {
        recipients = allStudents.filter(function(u) {
          return u.role === 'student' && u.grade === s.grade && u.fcmToken;
        });
      } else if (s.stage) {
        var cs = stageMap[s.stage] || s.stage;
        recipients = users.filter(function(u) {
          return u.role === 'student' && u.stage === cs && u.fcmToken;
        });
      }
      return {
        id: s.id,
        title: s.title,
        grade: s.grade,
        stage: s.stage,
        notifyAt: s.notifyAt,
        notified: s.notified,
        status: s.status,
        now: now,
        shouldNotify: shouldNotify,
        recipients: recipients.map(function(u) {
          return { id: u.id, grade: u.grade, stage: u.stage, role: u.role, fcmToken: (u.fcmToken || '').slice(0,20)+'...' };
        }),
        allStudentsWithFCM: allStudents.filter(function(u) { return u.fcmToken; }).map(function(u) {
          return { id: u.id, grade: u.grade, stage: u.stage, fcmToken: (u.fcmToken || '').slice(0,20)+'...' };
        })
      };
    });
    res.json({ now: now, sessions: info, totalSessions: sessions.length, totalStudentsWithFCM: allStudents.filter(function(u){return u.fcmToken;}).length });
  } catch(e) {
    res.status(500).json({ error: safeErr(e) });
  }
});

// Global error handler
app.use(function(err, req, res, next) {
  console.error('[ERROR]', req.method, req.url, err.stack || err.message || err);
  if (res.headersSent) return;
  var isFirebaseError = err && (err.code || (err.errorInfo && err.errorInfo.code));
  res.status(500).send(isFirebaseError ? getFirebaseErrorMessage(err) : 'حدث خطأ غير متوقع، يرجى المحاولة مرة أخرى.');
});

app.get('/admin/puter-ai', requireAdmin, async (req, res) => {
  res.render('admin/puter-ai', { title: 'مساعد الذكاء الاصطناعي', currentPath: req.path });
});

module.exports = app;
