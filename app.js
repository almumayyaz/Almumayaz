try { require('dotenv').config(); } catch (e) {}

require('express-async-errors');

const express = require('express');
const session = require('cookie-session');
const bodyParser = require('body-parser');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const { readData, writeData, fbAuth, sendFCM, sendFCMToRole, admin } = require('./firebase-admin');
const supabaseStorage = require('./supabase-storage');
const crypto = require('crypto');
const zlib = require('zlib');
const zoom = require('./zoom-oauth');
const analytics = require('./analytics-engine');
const perf = require('./perf');

const app = express();

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

// ===== Password hashing (native scrypt, no external deps) =====
const SCRYPT_N = 16384, SCRYPT_r = 8, SCRYPT_p = 1, SCRYPT_KEYLEN = 64, SCRYPT_SALTLEN = 16;
function scryptHash(plain) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SCRYPT_SALTLEN);
    crypto.scrypt(String(plain), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p }, (err, derived) => {
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
      crypto.scrypt(String(plain), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p }, (err, d) => err ? reject(err) : resolve(d));
    });
    return crypto.timingSafeEqual(derived, expected);
  }
  // Legacy plaintext fallback (transitional; rehashed on successful login)
  return stored === String(plain);
}

// ===== Client IP (works behind Vercel proxy) =====
function getClientIp(req) {
  return (req.headers && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) ||
         req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
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
    "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://cdnjs.cloudflare.com https://www.youtube.com https://www.youtube-nocookie.com https://source.zoom.us https://*.zoom.us https://zoom.us; " +
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.plyr.io https://fonts.googleapis.com https://source.zoom.us https://*.zoom.us https://zoom.us; " +
    "img-src 'self' data: https: blob:; " +
    "font-src 'self' data: https://cdnjs.cloudflare.com https://fonts.gstatic.com https://source.zoom.us; " +
    "media-src 'self' https: blob:; " +
    "connect-src 'self' https://www.gstatic.com https://*.supabase.co https://*.firebaseio.com https://*.googleapis.com https://*.google.com https://firebasestorage.googleapis.com https://*.firebase.com wss://*.firebaseio.com https://source.zoom.us https://*.zoom.us https://zoom.us wss://*.zoom.us https://*.cloudfront.net; " +
    "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://source.zoom.us https://*.zoom.us https://zoom.us; " +
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
  let ok = false;
  try { if (origin && new URL(origin).host === host) ok = true; } catch (e) {}
  try { if (!ok && referer && new URL(referer).host === host) ok = true; } catch (e) {}
  if (!ok) return res.status(403).json({ error: 'طلب غير مسموح' });
  next();
});

// ===== Inline IP rate limiter (no deps) =====
const _rateBuckets = {};
function rateLimit({ windowMs = 15 * 60 * 1000, max = 30, keyFn } = {}) {
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : getClientIp(req);
    const now = Date.now();
    const b = _rateBuckets[key] || (_rateBuckets[key] = { count: 0, resetAt: now + windowMs });
    if (now > b.resetAt) { b.count = 0; b.resetAt = now + windowMs; }
    b.count++;
    if (b.count > max) return res.status(429).json({ error: 'محاولات كثيرة، حاول لاحقاً' });
    next();
  };
}
const AUTH_LIMIT = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyFn: (req) => getClientIp(req) + ':' + (req.path || '') });
// Stage 9: analytics endpoints can be polled by the dashboard, so allow a higher
// ceiling than the strict auth limiter while still protecting against abuse.
const ANALYTICS_LIMIT = rateLimit({ windowMs: 15 * 60 * 1000, max: 400, keyFn: (req) => getClientIp(req) + ':' + (req.path || '') });
app.use((req, res, next) => {
  const p = req.path || '';
  if (p.startsWith('/api/auth') || p === '/login' || p === '/register' || p === '/forgot-password' || p.startsWith('/api/parent')) return AUTH_LIMIT(req, res, next);
  if (p.startsWith('/api/analytics')) return ANALYTICS_LIMIT(req, res, next);
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
app.use(session({
  name: 'lughati_session',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  maxAge: 30 * 24 * 60 * 60 * 1000,
  sameSite: 'lax',
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production'
}));

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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function stripBOM(s) {
  if (!s || typeof s !== 'string') return s;
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

// Keep only lightweight fields in the session COOKIE (cookie-session has a ~4KB limit;
// a Base64 avatar or large progress object would overflow it and drop the Set-Cookie,
// bouncing students back to /login). Heavy fields are re-attached from the DB for views.
function sessionUser(u) {
  if (!u || typeof u !== 'object') return u;
  const c = {};
  ['id','uid','name','email','role','stage','grade','governorate','phone','parentPhone','subscribedStage','planName','planPeriod','subscriptionStatus','subscriptionStart','subscriptionEnd','referralCode','referralDiscount','emailVerified','fcmToken','isStudent'].forEach(function(k){
    if (k in u) c[k] = u[k];
  });
  return c;
}

// ===== Email (Gmail SMTP via app password) =====
// Env vars: SMTP_USER, SMTP_PASS, SMTP_FROM
let _mailer = null;
function getMailer() {
  if (_mailer) return _mailer;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  _mailer = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  return _mailer;
}
async function sendMail(to, subject, html) {
  const t = getMailer();
  if (!t) { console.error('[mail] SMTP not configured (set SMTP_USER/SMTP_PASS)'); return false; }
  try {
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html });
    return true;
  } catch (e) { console.error('[mail] send error:', e && e.message); return false; }
}
function genEmailCode() { return String(crypto.randomInt(100000, 1000000)); }
const EMAIL_CODE_TTL = 30 * 60 * 1000;
function emailShell(title, bodyHtml) {
  return `<div dir="rtl" style="font-family:'Cairo',Tahoma,Arial,sans-serif;max-width:480px;margin:24px auto;background:#0f1b34;color:#f5e6c8;padding:28px;border-radius:16px;border:1px solid #2a3a5c;">
    <h2 style="color:#f3c969;text-align:center;margin:0 0 16px;font-family:'Aref Ruqaa',serif;font-size:26px;">${title}</h2>
    <div style="font-size:15px;line-height:1.9;">${bodyHtml}</div>
    <hr style="border:none;border-top:1px solid #2a3a5c;margin:20px 0;">
    <p style="font-size:12px;color:#9fb0c9;text-align:center;margin:0;">منصة المُميز — اللغة العربية</p>
  </div>`;
}
function verifyEmailHtml(name, code) {
  return emailShell('تأكيد البريد الإلكتروني',
    `مرحباً ${name || 'طالب المنصة'}،<br>كود تأكيد بريدك الإلكتروني هو:<br>
     <div style="font-size:30px;font-weight:bold;color:#f3c969;text-align:center;margin:14px 0;letter-spacing:6px;">${code}</div>
     <p style="text-align:center;color:#9fb0c9;font-size:13px;">هذا الكود صالح لمدة 30 دقيقة.</p>`);
}
function resetEmailHtml(name, code) {
  return emailShell('إعادة تعيين كلمة المرور',
    `مرحباً ${name || 'طالب المنصة'}،<br>كود إعادة تعيين كلمة المرور هو:<br>
     <div style="font-size:30px;font-weight:bold;color:#f3c969;text-align:center;margin:14px 0;letter-spacing:6px;">${code}</div>
     <p style="text-align:center;color:#9fb0c9;font-size:13px;">أدخل الكود مع كلمة المرور الجديدة. صالح لمدة 30 دقيقة.</p>`);
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
  next();
}

function checkSubscription(req, res, next) {
  const user = req.session.user;
  if (!user || user.role === 'admin') return next();
  if (user.subscriptionStatus === 'active' && user.subscriptionEnd) {
    const end = new Date(user.subscriptionEnd);
    if (end < new Date()) {
      user.subscriptionStatus = 'expired';
      readData('users').then(users => {
        const idx = users.findIndex(u => u.id === user.id);
        if (idx !== -1) { users[idx].subscriptionStatus = 'expired'; writeData('users', users); }
        sendFCM(user.id, 'انتهى اشتراكك في المُميز', 'لقد انتهت صلاحية اشتراكك. قم بتجديد الاشتراك للاستمرار في مشاهدة المحاضرات.', '/student/subscription');
      }).catch(() => {});
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
    const users = await readData('users');
    const fresh = users.find(u => u.id === user.id);
    if (fresh) {
      ['subscriptionStatus','subscriptionEnd','subscriptionStart','name','phone','parentPhone','stage','grade','governorate','referralCode','referralDiscount','fcmToken'].forEach(k => {
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
        // readData('users') is served from the short-TTL cache (stage 1/6), so this
        // is normally a cache hit with zero Firebase reads.
        const _us = await readData('users');
        const _list = Array.isArray(_us) ? _us : (_us ? Object.values(_us) : []);
        const _full = _list.find(u => u.uid === res.locals.user.uid);
        if (_full) {
          res.locals.user.avatar = _full.avatar || '';
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
    var appSettings = await readData('settings');
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
  try {
    res.locals.unreadCount = 0;
    const _u = res.locals.user;
    if (_u && _u.role === 'student' && _u.id) {
      const _msgs = await readData('chats/student-' + _u.id + '/messages') || {};
      let _n = 0;
      Object.keys(_msgs).forEach(function(k) {
        const m = _msgs[k];
        if (m && m.senderId === 'teacher' && !m.read) _n++;
      });
      res.locals.unreadCount = _n;
    }
  } catch (e) {
    res.locals.unreadCount = 0;
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
    // Migrate users: add referralDiscount
    var users = await readData('users');
    var usersChanged = false;
    users.forEach(function(u) {
      if (u.referralDiscount === undefined) { u.referralDiscount = 0; usersChanged = true; }
      if (!u.referralCode) { u.referralCode = 'REF-' + Math.random().toString(36).substr(2, 8).toUpperCase(); usersChanged = true; }
    });
    if (usersChanged) await writeData('users', users);
    // Delete lughati-chat if it exists
    try {
      const { fbRemove } = require('./firebase-admin');
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
    const decoded = await fbAuth.verifyIdToken(idToken);
    // Note: login is intentionally NOT gated on email verification — verification is
    // offered as an optional confirmation code at registration (see /api/auth/verify-email).
    const uid = decoded.uid;
    const users = await readData('users');
    let user = users.find(u => u.uid === uid);

    if (!user) {
      user = {
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
        subscriptionStart: null,
        subscriptionEnd: null,
        referralCode: '',
        referredBy: '',
        fcmToken: '',
        referralDiscount: 0,
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
        progress: {}
      };
      users.push(user);
      await writeData('users', users);
    } else {
      // Ensure fields exist for existing users
      if (user.referralDiscount === undefined) user.referralDiscount = 0;
      user.lastLogin = new Date().toISOString();
      const idx = users.findIndex(u => u.uid === uid);
      users[idx] = user;
      await writeData('users', users);
    }

    req.session.user = sessionUser(user);
    if (user.role === 'student') {
      analytics.trackLogin(user.uid, { device: req.headers['user-agent'] || '', browser: req.headers['user-agent'] || '', ip: req.ip || req.connection.remoteAddress || '' }).catch(function(){});
    }
    res.json({ success: true, redirect: user.role === 'admin' ? '/admin' : '/student' });
    } catch (e) {
      console.error('Firebase login error:', e);
      res.status(401).json({ error: 'تعذر إتمام تسجيل الدخول. تأكد من صحة بريدك الإلكتروني وكلمة المرور، أو حاول مرة أخرى لاحقاً.' });
    }
  });

app.post('/api/auth/firebase-register', async (req, res) => {
  try {
    if (!fbAuth) return res.status(503).json({ error: 'خدمة المصادقة غير متاحة حالياً' });
    const { idToken, name, email, phone, parentPhone, grade, stage, governorate, referralCode } = req.body;
    const decoded = await fbAuth.verifyIdToken(idToken);
    const uid = decoded.uid;

    let users = await readData('users');
    if (!Array.isArray(users)) users = users ? Object.values(users) : [];
    if (users.find(u => u.email === email)) {
      return res.status(409).json({ error: 'البريد الإلكتروني مسجل بالفعل' });
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
      subscriptionStart: null,
      subscriptionEnd: null,
      referralCode: 'REF-' + Math.random().toString(36).substr(2, 8).toUpperCase(),
      referredBy: referralCode || '',
      fcmToken: '',
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString(),
      progress: {},
      emailVerified: false,
      emailCode: genEmailCode(),
      emailCodeExpiry: Date.now() + EMAIL_CODE_TTL
    };

    if (referralCode) {
      const referrer = users.find(u => u.referralCode === referralCode);
      if (referrer) {
        newUser.referredBy = referrer.id;
        if (!referrer.referrals) referrer.referrals = [];
        referrer.referrals.push({ userId: uid, discount: 25, date: new Date().toISOString() });
        const ri = users.findIndex(u => u.referralCode === referralCode);
        if (ri !== -1) users[ri] = referrer;
      }
    }

    users.push(newUser);
    await writeData('users', users);

    const sent = await sendMail(email, 'كود تأكيد البريد الإلكتروني - منصة المُميز', verifyEmailHtml(name, newUser.emailCode));
    res.json({ success: true, emailSent: sent, email });
  } catch (e) {
    console.error('Firebase register error:', e);
    res.status(401).json({ error: 'فشل إنشاء الحساب' });
  }
});

async function loadUsers() {
  const users = await readData('users');
  return Array.isArray(users) ? users : (users ? Object.values(users) : []);
}

app.post('/api/auth/send-verify-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'البريد الإلكتروني مطلوب' });
    const users = await loadUsers();
    const user = users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: 'لا يوجد حساب بهذا البريد' });
    user.emailCode = genEmailCode();
    user.emailCodeExpiry = Date.now() + EMAIL_CODE_TTL;
    await writeData('users', users);
    const sent = await sendMail(email, 'كود تأكيد البريد الإلكتروني - منصة المُميز', verifyEmailHtml(user.name, user.emailCode));
    res.json({ success: true, emailSent: sent });
  } catch (e) { console.error('send-verify-code error:', e); res.status(500).json({ error: 'تعذر إرسال الكود' }); }
});

app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'البريد والكود مطلوبان' });
    const users = await loadUsers();
    const idx = users.findIndex(u => u.email === email);
    if (idx === -1) return res.status(404).json({ error: 'لا يوجد حساب بهذا البريد' });
    const user = users[idx];
    if (user.emailVerified) return res.json({ success: true });
    if (!user.emailCode || !user.emailCodeExpiry || Date.now() > user.emailCodeExpiry)
      return res.status(400).json({ error: 'الكود غير صالح أو منتهي الصلاحية' });
    if (String(user.emailCode) !== String(code)) return res.status(400).json({ error: 'الكود غير صحيح' });
    user.emailVerified = true;
    user.emailCode = null; user.emailCodeExpiry = null;
    if (fbAuth && user.uid) {
      try { await fbAuth.updateUser(user.uid, { emailVerified: true }); } catch (e) { console.error('fb verify update error:', e.message); }
    }
    users[idx] = user;
    await writeData('users', users);
    req.session.user = sessionUser(user);
    res.json({ success: true });
  } catch (e) { console.error('verify-email error:', e); res.status(500).json({ error: 'تعذر تأكيد البريد' }); }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'البريد الإلكتروني مطلوب' });
    const users = await loadUsers();
    const user = users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: 'لا يوجد حساب بهذا البريد' });
    user.resetCode = genEmailCode();
    user.resetCodeExpiry = Date.now() + EMAIL_CODE_TTL;
    await writeData('users', users);
    const sent = await sendMail(email, 'إعادة تعيين كلمة المرور - منصة المُميز', resetEmailHtml(user.name, user.resetCode));
    res.json({ success: true, emailSent: sent });
  } catch (e) { console.error('forgot-password error:', e); res.status(500).json({ error: 'تعذر إرسال الكود' }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    const users = await loadUsers();
    const idx = users.findIndex(u => u.email === email);
    if (idx === -1) return res.status(404).json({ error: 'لا يوجد حساب بهذا البريد' });
    const user = users[idx];
    if (!user.resetCode || !user.resetCodeExpiry || Date.now() > user.resetCodeExpiry)
      return res.status(400).json({ error: 'الكود غير صالح أو منتهي الصلاحية' });
    if (String(user.resetCode) !== String(code)) return res.status(400).json({ error: 'الكود غير صحيح' });
    user.password = await scryptHash(newPassword);
    user.resetCode = null; user.resetCodeExpiry = null;
    if (fbAuth && user.uid) {
      try { await fbAuth.updateUser(user.uid, { password: newPassword }); } catch (e) { console.error('fb password update error:', e.message); }
    }
    users[idx] = user;
    await writeData('users', users);
    res.json({ success: true });
  } catch (e) { console.error('reset-password error:', e); res.status(500).json({ error: 'تعذر تغيير كلمة المرور' }); }
});

app.post('/api/auth/firebase-admin-login', async (req, res) => {
  try {
    const { idToken } = req.body;
    const decoded = await fbAuth.verifyIdToken(idToken);
    const users = await readData('users');
    const user = users.find(u => u.uid === decoded.uid && u.role === 'admin');
    if (!user) return res.status(403).json({ error: 'غير مصرح بالدخول' });

    req.session.user = sessionUser(user);
    res.json({ success: true, redirect: '/admin' });
  } catch (e) {
    res.status(401).json({ error: 'تعذر تسجيل دخول المسؤول. حاول مرة أخرى.' });
  }
});

app.get('/', async (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    if (req.session.user.role === 'parent') return res.redirect('/parent/dashboard');
    return res.redirect('/student');
  }
  const courses = await readData('courses');
  const subscriptions = await readData('subscriptions');
  res.render('public/index', { courses, subscriptions, title: 'المُميز - منصة محمد عفيفي التعليمية' });
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
  const users = await readData('users');
  const idx = users.findIndex(u => u.email === email);
  if (idx === -1) return res.render('auth/login', { title: 'تسجيل الدخول - المُميز', error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
  const user = users[idx];
  const ok = await verifyPassword(user.password, password);
  if (!ok) return res.render('auth/login', { title: 'تسجيل الدخول - المُميز', error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
  if (typeof user.password === 'string' && !user.password.startsWith('scrypt$') && password) {
    user.password = await scryptHash(password);
    users[idx] = user;
    await writeData('users', users);
  }
  req.session.user = sessionUser(user);
  if (user.role === 'admin') return res.redirect('/admin');
  res.redirect('/student');
});

app.get('/register', (req, res) => {
  if (req.session.user && !req.session.demoMode) return req.session.user.role === 'admin' ? res.redirect('/admin') : res.redirect('/student');
  res.render('auth/register', { title: 'إنشاء حساب - المُميز', error: null });
});

app.post('/register', async (req, res) => {
  const { name, email, phone, parentPhone, grade, stage, governorate, password, referralCode } = req.body;
  const users = await readData('users');
  if (users.find(u => u.email === email)) return res.render('auth/register', { title: 'إنشاء حساب - المُميز', error: 'البريد الإلكتروني مسجل بالفعل' });
  const uid = uuidv4();
  const newUser = {
    id: uid, uid, name, email, phone: phone || '', parentPhone: parentPhone || '',
    grade, stage: stage || '', governorate: governorate || '', role: 'student',
    subscriptionStatus: 'inactive', subscriptionStart: null, subscriptionEnd: null,
    referralCode: 'REF-' + Math.random().toString(36).substr(2, 8).toUpperCase(),
    referredBy: referralCode || '',
    referralDiscount: 0,
    fcmToken: '', createdAt: new Date().toISOString(), lastLogin: new Date().toISOString(), progress: {},
    password: password ? await scryptHash(password) : ''
  };
  if (referralCode) {
    const referrer = users.find(u => u.referralCode === referralCode);
    if (referrer) {
      newUser.referredBy = referrer.id;
      if (!referrer.referrals) referrer.referrals = [];
      referrer.referrals.push({ userId: uid, discount: 25, date: new Date().toISOString() });
      const ri = users.findIndex(u => u.referralCode === referralCode);
      if (ri !== -1) users[ri] = referrer;
    }
  }
  users.push(newUser);
  await writeData('users', users);
  req.session.user = sessionUser(newUser);
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
    const userData = await readData('users');
    const u = userData && userData[req.session.user.uid];
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
  res.render('student/courses', { courses: courses, userStage: userStage, userGrade: userGrade, currentSemester: currentSemester, title: 'المحاضرات - المُميز' });
});

app.get('/student/course/:id', requireStudentOrGuest, async (req, res) => {
  const courses = await readData('courses');
  const course = courses.find(c => c.id === req.params.id);
  if (!course) return res.redirect('/student/courses');

  const user = req.session.user;
  const isGuest = req.session.demoMode;
  const isSubscribed = !isGuest && user.subscriptionStatus === 'active' && (!user.subscriptionEnd || new Date(user.subscriptionEnd) > new Date());
  const currentSemester = res.locals.currentSemester || 'all';

  let lessonStatuses = null;
  if (!isGuest && user.uid) {
    try {
      const a = await analytics.getAnalytics(user.uid);
      const computed = analytics.computeLessonStatuses(user.uid, course, a.lessonProgress || {}, a.courseProgress || {});
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

  const user = req.session.user;
  const isGuest = req.session.demoMode;
  const isSubscribed = !isGuest && user.subscriptionStatus === 'active' && (!user.subscriptionEnd || new Date(user.subscriptionEnd) > new Date());
  const isFree = lesson.isFree === true;

  if (!isFree && !isSubscribed && !(isGuest && lesson.guestVisible)) {
    return res.render('student/subscription-locked', { title: 'الاشتراك مطلوب - المُميز', isGuest });
  }

  let lessonStatuses = null;
  let isSequentiallyLocked = false;
  let hasVideo = !!(lesson.videos && lesson.videos.length) || !!lesson.videoUrl;

  if (!isGuest && user.uid) {
    try {
      const a = await analytics.getAnalytics(user.uid);
      const computed = analytics.computeLessonStatuses(user.uid, course, a.lessonProgress || {}, a.courseProgress || {});
      lessonStatuses = computed.lessonStatuses;
      const thisLesson = lessonStatuses.find(s => s.lessonId === lesson.id);
      if (thisLesson && !thisLesson.isUnlocked && !isFree) {
        isSequentiallyLocked = true;
      }
      if (!hasVideo && !isSequentiallyLocked && thisLesson && !thisLesson.isCompleted) {
        await analytics.trackVideoHeartbeat(user.uid, course.id, lesson.id, 9999, 10000, 0, true);
      }
    } catch(e) {}
  }

  if (isSequentiallyLocked) {
    return res.render('student/lesson-locked', { course, title: 'الدرس مقفول - المُميز' });
  }

  res.render('student/lesson', {
    course, lesson, user, isGuest, isSubscribed, isFree, hasVideo, lessonStatuses,
    title: `${lesson.title} - المُميز`
  });
});

app.get('/student/lesson-quiz/:courseId/:lessonId', requireStudentOrGuest, async (req, res) => {
  const courses = await readData('courses');
  const course = courses.find(c => c.id === req.params.courseId);
  if (!course) return res.redirect('/student/courses');
  const lesson = (course.lessons||[]).find(l => l.id === req.params.lessonId);
  if (!lesson) return res.redirect(`/student/course/${course.id}`);
  if (!lesson.quiz || !lesson.quiz.enabled) return res.redirect(`/student/lesson/${course.id}/${lesson.id}`);

  const user = req.session.user;
  const isGuest = req.session.demoMode;
  const isSubscribed = !isGuest && user.subscriptionStatus === 'active' && (!user.subscriptionEnd || new Date(user.subscriptionEnd) > new Date());
  const isFree = lesson.isFree === true;
  if (!isFree && !isSubscribed && !(isGuest && lesson.guestVisible)) {
    return res.render('student/subscription-locked', { title: 'الاشتراك مطلوب - المُميز', isGuest });
  }

  res.render('student/lesson-quiz', {
    course, lesson, isGuest,
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
      if (!supabaseStorage.isConfigured()) return res.status(503).json({ error: 'Storage not configured' });
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
      return res.status(status).json({ error: e && e.message || 'Unauthorized' });
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
      if (!supabaseStorage.isConfigured()) return res.status(503).end('Storage not configured');
      const { path } = await getPdfTarget(kind, req);
      const signed = await supabaseStorage.createSignedUrl(path, 60);
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
      if (!res.headersSent) res.status(status).end(e && e.message || 'Stream error');
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

/* ===== TEMP DIAGNOSTIC ONLY (remove after root-cause found) ===== */
app.get('/api/admin/diag-pdf', requireAdmin, async (req, res) => {
  const out = { note: 'TEMP DIAGNOSTIC - remove after use' };
  try {
    const ss = require('./supabase-storage');
    out.env = {
      SUPABASE_URL: process.env.SUPABASE_URL ? ('SET len=' + String(process.env.SUPABASE_URL).length) : 'MISSING',
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'SET' : 'MISSING'
    };
    out.bucketName = ss.BUCKET;
    out.isConfigured = ss.isConfigured();
    const { createClient } = require('@supabase/supabase-js');
    const client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    // 1) bucket exists?
    try { const b = await client.storage.getBucket(ss.BUCKET); out.bucket = { exists: !!(b && (b.name || b.id)), raw: b }; }
    catch (e) { out.bucket = { error: e.message, status: e.status, code: e.code }; }
    // 2) list objects actually stored (to compare against the DB path)
    try {
      const { data, error } = await client.storage.from(ss.BUCKET).list('', { limit: 200 });
      out.bucketObjects = error ? { error: error.message } : (data || []).map(o => o.name);
    } catch (e) { out.bucketObjects = { error: e.message }; }
    // 3) the stored DB path for lesson 1/101/0
    const courses = await readData('courses');
    const course = courses.find(c => c.id === '1');
    const lesson = course && (course.lessons || []).find(l => l.id === '101');
    const pf = lesson && lesson.pdfFiles && lesson.pdfFiles[0];
    out.dbPdfFilesShape = lesson ? (Array.isArray(lesson.pdfFiles) ? ('array[' + lesson.pdfFiles.length + ']') : typeof lesson.pdfFiles) : '(no lesson 1/101)';
    out.dbPath = pf ? pf.path : '(no pdfFiles[0])';
    out.dbPathType = pf ? typeof pf.path : 'n/a';
    // 4) run the EXACT module fn the app uses
    if (pf && pf.path) {
      try {
        const url = await ss.createSignedUrl(pf.path, 45);
        out.createSignedUrl = { ok: true, returned: url ? ('len=' + String(url).length) : 'EMPTY' };
      } catch (e) {
        out.createSignedUrl = { threw: true, message: e && e.message, status: e && e.status, code: e && e.code };
      }
    }
    res.json(out);
  } catch (e) {
    res.json({ fatal: e.message, stack: e.stack });
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
    if (!supabaseStorage.isConfigured()) {
      return res.status(503).json({ error: 'نظام التخزين غير مهيأ. أضف متغيرات Supabase في إعدادات المشروع.' });
    }
    const folder = (req.body.folder || 'misc').toString().replace(/[^a-z]/gi, '').toLowerCase() || 'misc';
    const path = _buildPdfPath(folder, req.body.fileName || 'file.pdf');
    const data = await supabaseStorage.createSignedUploadUrl(path);
    res.json({ success: true, path: path, signedUrl: data.signedUrl, token: data.token });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});
app.post('/api/admin/upload-pdf', requireAdmin, express.json(), async (req, res) => {
  try {
    if (!supabaseStorage.isConfigured()) {
      return res.status(503).json({ error: 'نظام التخزين غير مهيأ. أضف متغيرات Supabase في إعدادات المشروع.' });
    }
    const path = req.body.path;
    if (!path) return res.status(400).json({ error: 'لم يتم تحديد مسار الملف' });
    // Verify the object was actually uploaded to the private bucket.
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
    if (!supabaseStorage.isConfigured()) {
      return res.status(503).json({ error: 'نظام التخزين غير مهيأ.' });
    }
    if (!req.file) return res.status(400).json({ error: 'لم يتم إرفاق ملف' });
    const folder = (req.body.folder || 'misc').toString().replace(/[^a-z]/gi, '').toLowerCase() || 'misc';
    const path = await supabaseStorage.uploadPdf(folder, req.file.originalname, req.file.buffer, req.file.mimetype);
    res.json({ success: true, path: path });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.get('/student/exam/:courseId', requireStudent, async (req, res) => {
  const courses = await readData('courses');
  const course = courses.find(c => c.id === req.params.courseId);
  if (!course || !course.quiz) return res.redirect('/student/courses');
  res.render('student/exam', { course, title: `الاختبار - ${course.title} - المُميز` });
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
  res.render('student/review-detail', { review, title: `${review.title} - المُميز` });
});

app.get('/student/subscription', requireAuth, async (req, res) => {
  const subscriptions = await readData('subscriptions');
  const user = req.session.user;
  const isGuest = req.session.demoMode;
  const userStage = user && user.stage;
  const filtered = subscriptions.filter(s => !s.stage || s.stage === userStage);
  res.render('student/subscription', { subscriptions: filtered, user, isGuest, title: 'الاشتراك - المُميز' });
});

app.get('/student/payment', requireAuth, async (req, res) => {
  const isGuest = req.session.demoMode;
  res.render('student/payment', { isGuest, title: 'طلب اشتراك - المُميز' });
});

app.post('/api/student/submit-payment', requireAuth, async (req, res) => {
  try {
    const { transactionId, amount, paymentMethod: method, receiptImage } = req.body;
    const payments = await readData('payments') || [];
    const payment = {
      id: 'PAY-' + Date.now(),
      userId: req.session.user.id,
      userName: req.session.user.name,
      transactionId, amount, method,
      receiptImage: receiptImage || '',
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

app.get('/student/profile', requireStudent, (req, res) => {
  const u = req.session.user;
  const isSubscribed = u && u.subscriptionStatus === 'active' && (!u.subscriptionEnd || new Date(u.subscriptionEnd) > new Date());
  res.render('student/profile', { title: 'حسابي - المُميز', isSubscribed: !!isSubscribed });
});

app.put('/api/student/profile', requireAuth, async (req, res) => {
  try {
    const users = await readData('users');
    const idx = users.findIndex(u => u.id === req.session.user.id);
    if (idx === -1) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const u = users[idx];
    const isSubscribed = u.subscriptionStatus === 'active' && (!u.subscriptionEnd || new Date(u.subscriptionEnd) > new Date());
    // Whitelist-only: never trust client for role/subscription/ownership fields.
    const ALLOWED = ['name', 'phone', 'parentPhone', 'parentName', 'parentEmail', 'avatar', 'governorate'];
    const allowed = {};
    ALLOWED.forEach(function (k) { if (req.body[k] !== undefined) allowed[k] = req.body[k]; });
    if (!isSubscribed) {
      // المرحلة والصف يُتحكمان بخطة الاشتراك ولا يُسمح بتعديلهما أثناء الاشتراك.
      if (req.body.stage !== undefined) allowed.stage = req.body.stage;
      if (req.body.grade !== undefined) allowed.grade = req.body.grade;
    }
    Object.assign(u, allowed);
    u.lastLogin = new Date().toISOString();
    users[idx] = u;
    await writeData('users', users);
    req.session.user = sessionUser(users[idx]);
    res.json({ success: true, user: users[idx] });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== STUDENT REFERRAL DISCOUNT ===================== */

app.post('/api/student/apply-referral', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || !code.startsWith('REF-')) return res.status(400).json({ error: 'كود الدعوة غير صالح' });

    const users = await readData('users');
    const referrer = users.find(u => u.referralCode === code);
    if (!referrer) return res.status(404).json({ error: 'كود الدعوة غير موجود' });
    if (referrer.id === req.session.user.id) return res.status(400).json({ error: 'لا يمكنك استخدام كود دعوتك الشخصي' });

    const uidx = users.findIndex(u => u.id === req.session.user.id);
    if (uidx === -1) return res.status(404).json({ error: 'المستخدم غير موجود' });

    if (users[uidx].referralDiscount) return res.status(400).json({ error: 'لقد استخدمت كود دعوة من قبل' });

    // Apply 25% discount
    users[uidx].referralDiscount = 25;
    users[uidx].referredBy = referrer.id;

    // Track on referrer
    if (!referrer.referrals) referrer.referrals = [];
    referrer.referrals.push({ userId: req.session.user.id, discount: 25, date: new Date().toISOString() });
    const ri = users.findIndex(u => u.id === referrer.id);
    if (ri !== -1) users[ri] = referrer;

    await writeData('users', users);
    req.session.user = sessionUser(users[uidx]);

    res.json({ success: true, discount: 25, message: 'تم تطبيق خصم 25% على جميع خطط الاشتراك!' });
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

/* ===================== PARENT ACCOUNT SYSTEM ===================== */

function requireParent(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'parent') return res.redirect('/parent-login');
  next();
}

// Send parent invite (student side)
app.post('/api/student/send-parent-invite', requireAuth, async (req, res) => {
  try {
    const { parentName, parentPhone, parentEmail } = req.body;
    if (!parentName || !parentPhone) return res.status(400).json({ error: 'يرجى إدخال اسم ورقم هاتف ولي الأمر' });
    var invites = await readData('parentInvites') || [];
    // Check if already has active invite
    var existing = invites.find(i => i.studentId === req.session.user.id && i.status === 'pending');
    if (existing) {
      var link = req.protocol + '://' + req.get('host') + '/parent/invite/' + existing.token;
      return res.json({ success: true, inviteLink: link });
    }
    // Save parent info to student profile
    var users = await readData('users');
    var uidx = users.findIndex(u => u.id === req.session.user.id);
    if (uidx !== -1) {
      users[uidx].parentName = parentName;
      users[uidx].parentPhone = parentPhone;
      users[uidx].parentEmail = parentEmail || '';
      await writeData('users', users);
      req.session.user = sessionUser(users[uidx]);
    }
    var token = 'PINVITE-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8);
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
      createdAt: new Date().toISOString()
    };
    invites.push(invite);
    await writeData('parentInvites', invites);
    var inviteLink = req.protocol + '://' + req.get('host') + '/parent/invite/' + token;
    res.json({ success: true, inviteLink: inviteLink, invite: invite });
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
    var users = await readData('users');
    // Check if parent already exists with this phone
    var existingParent = users.find(u => u.role === 'parent' && u.phone === invite.parentPhone);
    if (existingParent) {
      // Link additional child to existing parent
      if (!existingParent.childrenIds) existingParent.childrenIds = [];
      if (!existingParent.childrenIds.includes(invite.studentId)) {
        existingParent.childrenIds.push(invite.studentId);
        await writeData('users', users);
      }
      invites[idx].status = 'accepted';
      invites[idx].acceptedAt = new Date().toISOString();
      invites[idx].parentUserId = existingParent.id;
      await writeData('parentInvites', invites);
      // Link student to parent
      var suidx = users.findIndex(u => u.id === invite.studentId);
      if (suidx !== -1) { users[suidx].parentId = existingParent.id; await writeData('users', users); }
      return res.json({ success: true, message: 'تم ربط الطالب بحساب ولي الأمر الحالي' });
    }
    // Create parent user with local password
    var parentId = 'PARENT-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
    var newParent = {
      id: parentId,
      uid: parentId,
      name: invite.parentName,
      phone: invite.parentPhone,
      email: invite.parentEmail || '',
      password: await scryptHash(password),
      role: 'parent',
      childrenIds: [invite.studentId],
      parentOf: [invite.studentName],
      fcmToken: '',
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString()
    };
    users.push(newParent);
    await writeData('users', users);
    // Link student to parent
    var suidx2 = users.findIndex(u => u.id === invite.studentId);
    if (suidx2 !== -1) { users[suidx2].parentId = parentId; await writeData('users', users); }
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
    var users = await readData('users');
    var idx = users.findIndex(u => u.role === 'parent' && u.phone === phone);
    if (idx === -1) return res.status(401).json({ error: 'رقم الهاتف أو كلمة المرور غير صحيحة' });
    var parent = users[idx];
    const ok = await verifyPassword(parent.password, password);
    if (!ok) return res.status(401).json({ error: 'رقم الهاتف أو كلمة المرور غير صحيحة' });
    if (typeof parent.password === 'string' && !parent.password.startsWith('scrypt$') && password) {
      parent.password = await scryptHash(password);
      users[idx] = parent;
      await writeData('users', users);
    }
    req.session.user = sessionUser(parent);
    res.json({ success: true, redirect: '/parent/dashboard' });
  } catch (e) {
    console.error('parent-login error:', e);
    res.status(500).json({ error: 'تعذر تسجيل الدخول، حاول لاحقاً' });
  }
});

// Parent dashboard
app.get('/parent/dashboard', requireParent, async (req, res) => {
  try {
    var users = await readData('users');
    var parent = users.find(u => u.id === req.session.user.id);
    if (!parent) return res.redirect('/logout');
    req.session.user = sessionUser(parent);
    var childrenIds = parent.childrenIds || [];
    if (childrenIds.length === 0) return res.render('parent/dashboard', { children: [], selectedChild: null, stats: {}, notifications: [], user: parent });
    var children = users.filter(u => childrenIds.includes(u.id));
    if (children.length === 0) return res.render('parent/dashboard', { children: [], selectedChild: null, stats: {}, notifications: [], user: parent });
    var selectedChildId = req.query.child || childrenIds[0];
    var selectedChild = users.find(u => u.id === selectedChildId);
    if (!selectedChild) selectedChild = children[0];

    // Compute stats for selected child
    var courses = await readData('courses') || [];
    var progress = selectedChild.progress || {};
    var completedLessons = 0;
    var totalLessons = 0;
    courses.forEach(function(c) {
      var cp = progress[c.id];
      if (cp && cp.completedLessons) completedLessons += cp.completedLessons.length;
      totalLessons += (c.sections || []).reduce(function(sum, s) { return sum + (s.lessons || []).length; }, 0);
    });
    var progressPercentage = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;

    // Exam stats
    var questionBanks = await readData('questionBanks') || [];
    var examResults = selectedChild.examResults || [];
    var completedExams = examResults.length;
    var avgScore = completedExams > 0 ? Math.round(examResults.reduce(function(sum, r) { return sum + (r.score || 0); }, 0) / completedExams) : 0;
    var lastExamResult = examResults.length > 0 ? examResults[examResults.length - 1] : null;

    // Total study hours (estimate from completed lessons)
    var totalHours = Math.round(completedLessons * 0.75);

    // Recent activity
    var recentActivity = [];
    if (selectedChild.activityLog) {
      recentActivity = selectedChild.activityLog.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
    }
    // Generate from progress data if no activity log
    if (recentActivity.length === 0) {
      Object.keys(progress).forEach(function(cid) {
        var cp = progress[cid];
        if (cp && cp.completedLessons) {
          cp.completedLessons.forEach(function(lid) {
            recentActivity.push({ type: 'lesson', text: 'أكمل درس في ' + (cp.courseName || 'مادة'), date: cp.updatedAt || new Date().toISOString() });
          });
        }
      });
      if (examResults.length > 0) {
        examResults.forEach(function(r) {
          recentActivity.push({ type: 'exam', text: 'حل اختبار ' + (r.examName || ''), date: r.date || new Date().toISOString() });
        });
      }
      recentActivity.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
    }

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
      lastExamScore: lastExamResult ? lastExamResult.score : null,
      recentActivity: recentActivity
    };

    // Notifications
    var notifications = [];
    if (selectedChild.notifications && Array.isArray(selectedChild.notifications)) {
      notifications = selectedChild.notifications;
    } else {
      var allNotifs = await readData('notifications') || [];
      notifications = allNotifs.filter(function(n) { return n.target === 'student' && n.targetValue === selectedChild.id; });
    }

    res.render('parent/dashboard', { children: children, selectedChild: selectedChild, stats: stats, notifications: notifications, user: parent });
  } catch (e) {
    res.status(500).send('حدث خطأ: ');
  }
});

// API: Get child progress data
app.get('/api/parent/child-progress/:childId', requireParent, async (req, res) => {
  try {
    var users = await readData('users');
    var parent = users.find(u => u.id === req.session.user.id);
    if (!parent) return res.status(404).json({ error: 'حساب ولي الأمر غير موجود' });
    var childrenIds = parent.childrenIds || [];
    if (!childrenIds.includes(req.params.childId)) return res.status(403).json({ error: 'غير مصرح بالوصول' });
    var child = users.find(u => u.id === req.params.childId);
    if (!child) return res.status(404).json({ error: 'الطالب غير موجود' });
    res.json({ success: true, child: { id: child.id, name: child.name, grade: child.grade, stage: child.stage, subscriptionStatus: child.subscriptionStatus, phone: child.phone } });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== STUDENT SUBSCRIPTION API ===================== */

app.post('/api/student/subscribe', requireAuth, async (req, res) => {
  try {
    const { planName, price, transactionId, paymentMethod, stage } = req.body;
    if (!transactionId) return res.status(400).json({ error: 'يرجى إدخال كود العملية' });
    const subs = await readData('subscriptions') || [];
    const sub = subs.find(s => s.name === planName);
    const subRequests = await readData('subRequests') || [];
    const request = {
      id: 'SUB-' + Date.now(),
      userId: req.session.user.id,
      userName: req.session.user.name,
      userPhone: req.session.user.phone || '',
      planName, price, transactionId, paymentMethod: paymentMethod || 'vodafone-cash',
      planId: sub ? sub.id : '',
      planStage: stage || (sub ? (sub.stage || '') : ''),
      period: sub ? (sub.period || '') : '',
      durationDays: sub ? (sub.durationDays || 30) : 30,
      status: 'pending',
      date: new Date().toISOString(),
      discount: req.session.user.referralDiscount || 0
    };
    subRequests.push(request);
    await writeData('subRequests', subRequests);
    res.json({ success: true, request });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.get('/api/admin/sub-requests', requireAdmin, async (req, res) => {
  try {
    const subRequests = await readData('subRequests') || [];
    res.json({ success: true, requests: subRequests.reverse() });
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
      const users = await readData('users');
      const uidx = users.findIndex(u => u.id === subRequests[idx].userId);
      if (uidx !== -1) {
        users[uidx].subscriptionStatus = 'active';
        users[uidx].subscriptionStart = new Date().toISOString();
        const durDays = parseInt(subRequests[idx].durationDays) || 30;
        users[uidx].subscriptionEnd = new Date(Date.now() + durDays * 24 * 60 * 60 * 1000).toISOString();
        if (subRequests[idx].planStage) users[uidx].subscribedStage = subRequests[idx].planStage;
        users[uidx].planName = subRequests[idx].planName || '';
        users[uidx].planPeriod = subRequests[idx].period || '';
        await writeData('users', users);
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

app.delete('/api/admin/sub-requests/:id', requireAdmin, async (req, res) => {
  try {
    const subRequests = await readData('subRequests') || [];
    const idx = subRequests.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الطلب غير موجود' });
    subRequests.splice(idx, 1);
    await writeData('subRequests', subRequests);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== CHAT API (SERVER-SIDE) ===================== */

const { fbRead, fbSet, fbPush, fbRemove } = require('./firebase-admin');

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
    res.json({ success: true, messages: msgs });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

app.post('/api/student/chat/send', requireStudent, async (req, res) => {
  try {
    const cid = chatId(req);
    const { text, image } = req.body;
    if (!text && !image) return res.status(400).json({ error: 'لا يمكن إرسال رسالة فارغة' });
    const msg = { senderId: senderId(req), senderName: req.session.user.name || 'زائر', timestamp: Date.now(), read: false, text: text || '', image: image || '' };
    const key = await fbPush('chats/' + cid + '/messages', msg);
    // Send push to admin
    const users = await readData('users');
    const adminUser = users.find(u => u.role === 'admin' && u.fcmToken);
    if (adminUser) {
      try {
        const m = { token: adminUser.fcmToken, data: { title: 'رسالة جديدة من ' + (req.session.user.name || 'طالب'), body: text ? (text.length > 80 ? text.slice(0,80) + '...' : text) : '📷 صورة', url: '/admin/chat/' + encodeURIComponent(req.session.user.id || (req.session.guestChatId || '')) } };
        await admin.messaging().send(m);
      } catch(e) { console.error('Chat push error:', e.code || e.message); }
    }
    res.json({ success: true, key: key, message: msg });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

app.get('/api/admin/chat/:studentId/messages', requireAdmin, async (req, res) => {
  try {
    const chatId = 'student-' + req.params.studentId;
    const data = await fbRead('chats/' + chatId + '/messages');
    const msgs = data ? Object.keys(data).map(function(k) { var m=data[k]; m._key=k; return m; }).sort(function(a,b){return (a.timestamp||0)-(b.timestamp||0)}) : [];
    res.json({ success: true, messages: msgs });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

app.post('/api/admin/chat/:studentId/send', requireAdmin, async (req, res) => {
  try {
    const chatId = 'student-' + req.params.studentId;
    const { text, image } = req.body;
    if (!text && !image) return res.status(400).json({ error: 'لا يمكن إرسال رسالة فارغة' });
    const msg = { senderId: 'teacher', senderName: 'محمد عفيفي', timestamp: Date.now(), read: false, text: text || '', image: image || '' };
    const key = await fbPush('chats/' + chatId + '/messages', msg);
    // Send push to student
    sendFCM(req.params.studentId, 'رسالة جديدة من الأستاذ محمد عفيفي 📩', text ? (text.length > 80 ? text.slice(0,80) + '...' : text) : '📷 صورة', '/student/chat');
    res.json({ success: true, key: key, message: msg });
  } catch (e) { res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' }); }
});

app.delete('/api/admin/chat/:studentId', requireAdmin, async (req, res) => {
  try {
    const chatId = 'student-' + req.params.studentId;
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

app.put('/api/admin/chat/:studentId/read', requireAdmin, async (req, res) => {
  try {
    const chatId = 'student-' + req.params.studentId;
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
    const { courseId, lessonId, completed, percentage } = req.body;
    const users = await readData('users');
    const idx = users.findIndex(u => u.id === req.session.user.id);
    if (idx === -1) return res.status(404).json({ error: 'المستخدم غير موجود' });

    if (!users[idx].progress) users[idx].progress = {};
    if (!users[idx].progress[courseId]) users[idx].progress[courseId] = { completedLessons: [], percentage: 0 };

    if (completed) {
      if (!users[idx].progress[courseId].completedLessons.includes(lessonId)) {
        users[idx].progress[courseId].completedLessons.push(lessonId);
      }
    }
    if (percentage !== undefined) {
      users[idx].progress[courseId].percentage = percentage;
    }

    await writeData('users', users);
    req.session.user = sessionUser(users[idx]);
    res.json({ success: true, progress: users[idx].progress[courseId] });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.get('/api/student/progress/:courseId', requireAuth, async (req, res) => {
  try {
    const users = await readData('users');
    const user = users.find(u => u.id === req.session.user.id);
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const progress = (user.progress && user.progress[req.params.courseId]) || { completedLessons: [], percentage: 0 };
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
    const result = await analytics.trackVideoHeartbeat(uid, courseId, lessonId, position || 0, duration || 1, watchedSeconds || 0, !!forceComplete);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get watch status for a specific lesson (resume position, completion status)
app.get('/api/analytics/video/status', requireAuth, async (req, res) => {
  try {
    const { courseId, lessonId } = req.query;
    const uid = req.session.user.uid;
    const a = await analytics.getAnalytics(uid);
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
    res.status(500).json({ error: e.message });
  }
});

// PDF open tracking
app.post('/api/analytics/pdf/open', requireAuth, async (req, res) => {
  try {
    const { courseId, lessonId, lessonTitle } = req.body;
    await analytics.trackPdfOpen(req.session.user.uid, courseId, lessonId, lessonTitle);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Quiz submit — save attempt results
app.post('/api/analytics/quiz/submit', requireAuth, async (req, res) => {
  try {
    const { courseId, quizId, quizTitle, score, total, correct, wrong, timeTaken } = req.body;
    const result = await analytics.trackQuizSubmit(req.session.user.uid, courseId, quizId, quizTitle, score, total, correct, wrong, timeTaken);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get own analytics (student) — replaces GET /api/student/my-progress logic
app.get('/api/analytics/student', requireAuth, async (req, res) => {
  try {
    const data = await analytics.getStudentDashboardData(req.session.user.uid);
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Migration for existing users (admin only, one-time)
app.post('/api/analytics/migrate', requireAdmin, async (req, res) => {
  try {
    const result = await analytics.migrateAll();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: full analytics overview (engine v2)
app.get('/api/admin/analytics/v2/overview', requireAdmin, async (req, res) => {
  try {
    const data = await analytics.getAdminAnalytics();
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: delete ALL analytics data (from DB too)
app.post('/api/admin/analytics/v2/delete-all', requireAdmin, async (req, res) => {
  try {
    const result = await analytics.deleteAllAnalytics();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: save a snapshot/backup of current analytics
app.post('/api/admin/analytics/v2/backup', requireAdmin, async (req, res) => {
  try {
    const result = await analytics.backupAnalytics();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: single student detail (engine v2)
app.get('/api/admin/analytics/v2/student/:studentId', requireAdmin, async (req, res) => {
  try {
    const data = await analytics.getAdminStudentDetail(req.params.studentId);
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    var users = await readData('users');
    var courses = await readData('courses');
    var now = Date.now();
    var day = 86400000;
    var students = users.filter(function(u) { return u.role === 'student'; });
    var totalStudents = students.length;
    var activeToday = students.filter(function(u) { return u.lastLogin && (now - new Date(u.lastLogin).getTime() < day); }).length;
    var activeThisWeek = students.filter(function(u) { return u.lastLogin && (now - new Date(u.lastLogin).getTime() < 7 * day); }).length;
    var activeThisMonth = students.filter(function(u) { return u.lastLogin && (now - new Date(u.lastLogin).getTime() < 30 * day); }).length;
    var activeSubs = students.filter(function(u) { return u.subscriptionStatus === 'active'; }).length;
    var expiredSubs = students.filter(function(u) { return u.subscriptionStatus === 'expired' || (u.subscriptionEnd && new Date(u.subscriptionEnd).getTime() < now); }).length;

    // Calculate average completion
    var totalCompletion = 0, completionCount = 0;
    students.forEach(function(s) {
      if (s.progress) {
        Object.keys(s.progress).forEach(function(cid) {
          totalCompletion += (s.progress[cid].percentage || 0);
          completionCount++;
        });
      }
    });
    var avgCompletion = completionCount > 0 ? Math.round(totalCompletion / completionCount) : 0;

    // Calculate average quiz score
    var totalScore = 0, scoreCount = 0;
    students.forEach(function(s) {
      if (s.examResults && s.examResults.length) {
        s.examResults.forEach(function(r) {
          totalScore += (r.score || 0);
          scoreCount++;
        });
      }
    });
    var avgQuizScore = scoreCount > 0 ? Math.round(totalScore / scoreCount) : 0;

    res.json({
      totalStudents: totalStudents,
      activeToday: activeToday,
      activeThisWeek: activeThisWeek,
      activeThisMonth: activeThisMonth,
      activeSubscriptions: activeSubs,
      expiredSubscriptions: expiredSubs,
      averageCompletion: avgCompletion,
      averageQuizScore: avgQuizScore,
      totalCourses: courses.length
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/analytics/students?sort=most|least&limit=10
app.get('/api/admin/analytics/students', requireAdmin, async (req, res) => {
  try {
    var users = await readData('users');
    var courses = await readData('courses');
    var sort = req.query.sort || 'most';
    var limit = parseInt(req.query.limit) || 10;
    var students = users.filter(function(u) { return u.role === 'student'; });

    // Build a map of courseId -> total lesson count
    var lessonCountMap = {};
    courses.forEach(function(c) {
      if (c.lessons) lessonCountMap[c.id] = c.lessons.length;
    });

    var now = Date.now();
    var day = 86400000;

    var scored = students.map(function(s) {
      var completedCount = 0;
      var totalLessons = 0;
      var totalWatchMinutes = 0;
      if (s.progress) {
        Object.keys(s.progress).forEach(function(cid) {
          if (s.progress[cid].completedLessons) {
            completedCount += s.progress[cid].completedLessons.length;
          }
          if (lessonCountMap[cid]) totalLessons += lessonCountMap[cid];
          // Estimate watch time from completed lessons' durations
          if (s.progress[cid].completedLessons && courses) {
            var course = courses.find(function(c) { return c.id === cid; });
            if (course && course.lessons) {
              s.progress[cid].completedLessons.forEach(function(lid) {
                var lesson = course.lessons.find(function(l) { return l.id === lid; });
                if (lesson) totalWatchMinutes += parseDuration(lesson.duration);
              });
            }
          }
        });
      }

      // Quiz score
      var avgQuiz = 0;
      if (s.examResults && s.examResults.length) {
        var sum = 0;
        s.examResults.forEach(function(r) { sum += (r.score || 0); });
        avgQuiz = Math.round(sum / s.examResults.length);
      }

      // Completion percentage
      var completionPct = totalLessons > 0 ? Math.round((completedCount / totalLessons) * 100) : 0;

      // Activity Score: 40% completion + 30% lessons ratio + 20% quiz + 10% login recency
      var lessonRatio = totalLessons > 0 ? (completedCount / totalLessons) * 100 : 0;
      var loginRecency = 0;
      if (s.lastLogin) {
        var daysSinceLogin = (now - new Date(s.lastLogin).getTime()) / day;
        loginRecency = Math.max(0, 100 - daysSinceLogin * 3.33); // 0-30 days maps to 100-0
      }
      var activityScore = Math.round(
        (completionPct * 0.4) + (lessonRatio * 0.3) + (avgQuiz * 0.2) + (loginRecency * 0.1)
      );

      return {
        id: s.id,
        name: s.name || '',
        grade: s.grade || '',
        stage: s.stage || '',
        governorate: s.governorate || '',
        subscriptionStatus: s.subscriptionStatus || '',
        completedLessons: completedCount,
        totalLessons: totalLessons,
        completionPct: completionPct,
        totalWatchMinutes: Math.round(totalWatchMinutes),
        avgQuizScore: avgQuiz,
        activityScore: activityScore,
        lastLogin: s.lastLogin || '',
        createdAt: s.createdAt || ''
      };
    });

    if (sort === 'least') {
      scored.sort(function(a, b) { return a.activityScore - b.activityScore; });
    } else {
      scored.sort(function(a, b) { return b.activityScore - a.activityScore; });
    }

    res.json(scored.slice(0, limit));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/analytics/lessons — Lesson analytics
app.get('/api/admin/analytics/lessons', requireAdmin, async (req, res) => {
  try {
    var users = await readData('users');
    var courses = await readData('courses');
    var students = users.filter(function(u) { return u.role === 'student'; });
    var result = [];

    courses.forEach(function(c) {
      if (!c.lessons || !c.lessons.length) return;
      c.lessons.forEach(function(l) {
        var completedCount = 0;
        var watchMinutes = 0;
        var studentCount = 0;
        students.forEach(function(s) {
          if (s.progress && s.progress[c.id] && s.progress[c.id].completedLessons) {
            if (s.progress[c.id].completedLessons.includes(l.id)) {
              completedCount++;
              watchMinutes += parseDuration(l.duration);
            }
          }
          // Count students who have this course in their progress
          if (s.progress && s.progress[c.id]) studentCount++;
        });
        result.push({
          courseId: c.id,
          courseTitle: c.title,
          lessonId: l.id,
          lessonTitle: l.title,
          duration: l.duration,
          totalStudents: studentCount,
          completedCount: completedCount,
          completionRate: studentCount > 0 ? Math.round((completedCount / studentCount) * 100) : 0
        });
      });
    });

    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/analytics/quizzes — Quiz analytics
app.get('/api/admin/analytics/quizzes', requireAdmin, async (req, res) => {
  try {
    var users = await readData('users');
    var courses = await readData('courses');
    var students = users.filter(function(u) { return u.role === 'student'; });
    var result = [];

    courses.forEach(function(c) {
      if (!c.quiz || !c.quiz.questions || !c.quiz.questions.length) return;
      var scores = [];
      students.forEach(function(s) {
        if (s.examResults && s.examResults.length) {
          s.examResults.forEach(function(r) {
            if (r.examName && r.examName.indexOf(c.quiz.title) !== -1) {
              scores.push(r.score || 0);
            }
          });
        }
      });
      if (scores.length) {
        var sum = scores.reduce(function(a, b) { return a + b; }, 0);
        var maxScore = c.quiz.questions.length * 10; // Each question worth 10
        var passCount = scores.filter(function(s) { return s >= 50; }).length;
        result.push({
          courseId: c.id,
          courseTitle: c.title,
          quizTitle: c.quiz.title,
          totalQuestions: c.quiz.questions.length,
          attempts: scores.length,
          averageScore: Math.round(sum / scores.length),
          highestScore: Math.max.apply(null, scores),
          lowestScore: Math.min.apply(null, scores),
          passRate: Math.round((passCount / scores.length) * 100)
        });
      }
    });

    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/analytics/student/:studentId — Full student progress (teacher view)
app.get('/api/admin/analytics/student/:studentId', requireAdmin, async (req, res) => {
  try {
    var users = await readData('users');
    var courses = await readData('courses');
    var student = users.find(function(u) { return u.id === req.params.studentId && u.role === 'student'; });
    if (!student) return res.status(404).json({ error: 'الطالب غير موجود' });

    var now = Date.now();
    var day = 86400000;
    var totalCompleted = 0;
    var totalLessons = 0;
    var totalWatchMinutes = 0;
    var courseProgress = [];

    courses.forEach(function(c) {
      if (!c.lessons) return;
      var prog = student.progress && student.progress[c.id];
      var completed = prog && prog.completedLessons ? prog.completedLessons : [];
      var pct = prog ? (prog.percentage || 0) : 0;
      totalLessons += c.lessons.length;
      totalCompleted += completed.length;

      var lessons = c.lessons.map(function(l) {
        var isCompleted = completed.includes(l.id);
        if (isCompleted) totalWatchMinutes += parseDuration(l.duration);
        return {
          id: l.id,
          title: l.title,
          completed: isCompleted,
          duration: l.duration
        };
      });

      courseProgress.push({
        courseId: c.id,
        courseTitle: c.title,
        percentage: pct,
        completedCount: completed.length,
        totalCount: c.lessons.length,
        lessons: lessons
      });
    });

    // Quiz results
    var quizResults = student.examResults || [];

    // Recent activity (from examResults + progress)
    var recentActivity = [];
    if (student.progress) {
      Object.keys(student.progress).forEach(function(cid) {
        var prog = student.progress[cid];
        if (prog.completedLessons) {
          prog.completedLessons.forEach(function(lid) {
            recentActivity.push({
              type: 'completed_lesson',
              courseId: cid,
              lessonId: lid,
              date: prog.updatedAt || ''
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
        date: r.date || ''
      });
    });
    recentActivity.sort(function(a, b) { return new Date(b.date || 0) - new Date(a.date || 0); });
    recentActivity = recentActivity.slice(0, 50);

    // Activity Score
    var avgQuiz = 0;
    if (quizResults.length) {
      var sum = 0;
      quizResults.forEach(function(r) { sum += (r.score || 0); });
      avgQuiz = Math.round(sum / quizResults.length);
    }
    var completionPct = totalLessons > 0 ? Math.round((totalCompleted / totalLessons) * 100) : 0;
    var loginRecency = student.lastLogin ? Math.max(0, 100 - ((now - new Date(student.lastLogin).getTime()) / day) * 3.33) : 0;
    var activityScore = Math.round(
      (completionPct * 0.4) + (completionPct * 0.3) + (avgQuiz * 0.2) + (loginRecency * 0.1)
    );

    res.json({
      student: {
        id: student.id,
        name: student.name,
        email: student.email,
        phone: student.phone,
        grade: student.grade,
        stage: student.stage,
        governorate: student.governorate,
        subscriptionStatus: student.subscriptionStatus,
        subscriptionStart: student.subscriptionStart,
        subscriptionEnd: student.subscriptionEnd,
        createdAt: student.createdAt,
        lastLogin: student.lastLogin
      },
      progress: {
        completedLessons: totalCompleted,
        remainingLessons: totalLessons - totalCompleted,
        totalLessons: totalLessons,
        completionPct: completionPct,
        totalWatchMinutes: Math.round(totalWatchMinutes),
        avgQuizScore: avgQuiz,
        activityScore: activityScore,
        completedQuizzes: quizResults.length
      },
      courseProgress: courseProgress,
      quizResults: quizResults,
      recentActivity: recentActivity
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/student/my-progress — Student's own progress
app.get('/api/student/my-progress', requireAuth, async (req, res) => {
  try {
    var users = await readData('users');
    var courses = await readData('courses');
    var student = users.find(function(u) { return u.id === req.session.user.id; });
    if (!student) return res.status(404).json({ error: 'المستخدم غير موجود' });

    var now = Date.now();
    var day = 86400000;
    var totalCompleted = 0;
    var totalLessons = 0;
    var totalWatchMinutes = 0;
    var courseProgress = [];

    courses.forEach(function(c) {
      if (!c.lessons) return;
      var prog = student.progress && student.progress[c.id];
      var completed = prog && prog.completedLessons ? prog.completedLessons : [];
      totalLessons += c.lessons.length;
      totalCompleted += completed.length;

      completed.forEach(function(lid) {
        var lesson = c.lessons.find(function(l) { return l.id === lid; });
        if (lesson) totalWatchMinutes += parseDuration(lesson.duration);
      });

      courseProgress.push({
        courseId: c.id,
        courseTitle: c.title,
        percentage: prog ? (prog.percentage || 0) : 0,
        completedCount: completed.length,
        totalCount: c.lessons.length
      });
    });

    var quizResults = student.examResults || [];
    var avgQuiz = 0;
    if (quizResults.length) {
      var sum = 0;
      quizResults.forEach(function(r) { sum += (r.score || 0); });
      avgQuiz = Math.round(sum / quizResults.length);
    }

    var completionPct = totalLessons > 0 ? Math.round((totalCompleted / totalLessons) * 100) : 0;
    var loginRecency = 100;
    if (student.lastLogin) {
      var daysSince = (now - new Date(student.lastLogin).getTime()) / day;
      loginRecency = Math.max(0, 100 - daysSince * 3.33);
    }
    var activityScore = Math.round(
      (completionPct * 0.4) + (completionPct * 0.3) + (avgQuiz * 0.2) + (loginRecency * 0.1)
    );

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
      var daysSince = Math.round((now - new Date(student.lastLogin).getTime()) / day);
      streakDays = daysSince <= 1 ? 1 : 0;
      // Simplified: if logged in today or yesterday, streak is at least 1
      // For a real streak, we'd need login history
    }

    // Recent activity
    var recentActivity = [];
    if (student.progress) {
      Object.keys(student.progress).forEach(function(cid) {
        var course = courses.find(function(c) { return c.id === cid; });
        if (student.progress[cid].completedLessons) {
          student.progress[cid].completedLessons.forEach(function(lid) {
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
    res.status(500).json({ error: e.message });
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
    const users = await readData('users');
    const courses = await readData('courses');
    const students = users.filter(u => u.role === 'student');
    const announcements = await readData('announcements');
    const subscriptions = await readData('subscriptions');
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
  const users = await readData('users');
  const students = users.filter(u => u.role === 'student');
  res.render('admin/students', { students, title: 'الطلاب - الإدارة' });
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
  const subscriptions = await readData('subscriptions');
  res.render('admin/subscriptions', { subscriptions, title: 'الاشتراكات - الإدارة' });
});

app.get('/admin/payments', requireAdmin, async (req, res) => {
  try {
    const payments = await readData('payments') || [];
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
    title: 'الإعدادات - الإدارة'
  });
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

app.get('/admin/sub-requests', requireAdmin, async (req, res) => {
  res.render('admin/sub-requests', { title: 'طلبات الاشتراك - الإدارة' });
});

app.get('/admin/chat/:studentId', requireAdmin, (req, res) => {
  const chatId = 'student-' + req.params.studentId;
  res.render('admin/chat', { chatId, title: 'محادثة طالب - الإدارة' });
});

/* ===================== ADMIN API: CHATS ===================== */

app.get('/api/admin/chats', requireAdmin, async (req, res) => {
  try {
    const allChats = await fbRead('chats');
    if (!allChats || typeof allChats !== 'object') return res.json({ success: true, chats: [] });
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
      const studentName = lastMsg ? lastMsg.senderName : (chatId.startsWith('guest-') ? 'زائر' : studentId);
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
    Object.assign(courses[idx], req.body);
    await writeData('courses', courses);
    res.json({ success: true, course: courses[idx] });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.delete('/api/admin/courses/:id', requireAdmin, async (req, res) => {
  try {
    const courses = await readData('courses');
    const idx = courses.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'المادة غير موجودة' });
    courses.splice(idx, 1);
    await writeData('courses', courses);
    res.json({ success: true });
  } catch (e) {
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
    Object.assign(section, req.body);
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
    const { title, description, videos, pdfFiles, duration, order, isFree, guestVisible, sectionId } = req.body;
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
      sectionId: sectionId || ''
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
    const { title, description, videos, pdfFiles, duration, order, isFree, guestVisible, sectionId, quiz } = req.body;
    if (title !== undefined) lesson.title = title;
    if (description !== undefined) lesson.description = description;
    if (videos !== undefined) lesson.videos = videos;
    if (pdfFiles !== undefined) lesson.pdfFiles = pdfFiles;
    if (duration !== undefined) lesson.duration = duration;
    if (order !== undefined) lesson.order = order;
    if (isFree !== undefined) lesson.isFree = isFree;
    if (guestVisible !== undefined) lesson.guestVisible = guestVisible;
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

app.post('/api/admin/migrate-seed', requireAdmin, async (req, res) => {
  try {
    const { migrateSeedData, fbDb } = require('./firebase-admin');
    await migrateSeedData();
    res.json({ success: true, message: 'تم ترحيل البيانات بنجاح' });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.post('/api/admin/force-migrate', requireAdmin, async (req, res) => {
  try {
    const { fbDb, writeData } = require('./firebase-admin');
    const localStore = require('./data-store');
    const keys = ['courses', 'announcements', 'subscriptions', 'reviews'];
    const results = {};
    for (const key of keys) {
      const local = await localStore.readData(key);
      if (local && fbDb) {
        const data = Array.isArray(local) ? local : Object.values(local);
        // Use writeData so the in-memory cache is invalidated consistently.
        await writeData(key, data);
        results[key] = Array.isArray(local) ? local.length : Object.keys(local).length;
        console.log('Force-migrated', key, 'to Firebase');
      }
    }
    // Also migrate courses one by one to ensure lessons are included
    const localCourses = await localStore.readData('courses');
    if (Array.isArray(localCourses) && fbDb) {
      await writeData('courses', localCourses);
      results.courses = localCourses.length + ' courses with lessons';
    }
    res.json({ success: true, message: 'تم فرض الترحيل', results });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.get('/api/admin/diagnose', requireAdmin, async (req, res) => {
  try {
    const { fbDb } = require('./firebase-admin');
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
    const { title, questions, timerMinutes } = req.body;
    course.quiz = {
      id: course.quiz ? course.quiz.id : 'q' + Date.now(),
      title: title || (course.quiz ? course.quiz.title : 'اختبار شامل'),
      questions: questions || [],
      timerMinutes: timerMinutes || null
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
    Object.assign(notes[idx], req.body);
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
    notes.splice(idx, 1);
    await writeData('notes', notes);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN API: QUESTION BANKS (بنوك الأسئلة) ===================== */

app.post('/api/admin/question-banks', requireAdmin, async (req, res) => {
  try {
    const banks = (await readData('questionBanks')) || [];
    const { courseId, title, description, timerMinutes, order, questions } = req.body;
    var courses = await readData('courses');
    var course = courses.find(function(c) { return c.id === courseId; });
    const newBank = {
      id: 'qb-' + Date.now(),
      courseId: courseId || '',
      stage: course ? course.stage : '',
      grade: course ? course.grade : '',
      title: title || 'بنك أسئلة جديد',
      description: description || '',
      timerMinutes: timerMinutes || null,
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
    Object.assign(banks[idx], req.body);
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
    const { name, price, currency, period, features, popular, stage, durationDays } = req.body;
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
    Object.assign(subscriptions[idx], req.body);
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
    Object.assign(settings, req.body);
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
    Object.assign(announcements[idx], req.body);
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
    const users = await readData('users');
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الطالب غير موجود' });
    Object.assign(users[idx], req.body);
    await writeData('users', users);
    res.json({ success: true, student: users[idx] });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.delete('/api/admin/students/:id', requireAdmin, async (req, res) => {
  try {
    const users = await readData('users');
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الطالب غير موجود' });
    users.splice(idx, 1);
    await writeData('users', users);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

/* ===================== ADMIN API: STUDENT SUBSCRIPTION ===================== */

app.put('/api/admin/students/:id/subscription', requireAdmin, async (req, res) => {
  try {
    const users = await readData('users');
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الطالب غير موجود' });
    const { action, durationDays, stage, planName, period } = req.body;

    switch (action) {
      case 'activate':
        users[idx].subscriptionStatus = 'active';
        users[idx].subscriptionStart = new Date().toISOString();
        users[idx].subscriptionEnd = new Date(Date.now() + (durationDays || 30) * 24 * 60 * 60 * 1000).toISOString();
        if (stage) users[idx].subscribedStage = stage;
        if (planName) users[idx].planName = planName;
        if (period) users[idx].planPeriod = period;
        break;
      case 'deactivate':
        users[idx].subscriptionStatus = 'inactive';
        users[idx].planName = '';
        users[idx].planPeriod = '';
        break;
      case 'extend':
        if (users[idx].subscriptionEnd) {
          const end = new Date(users[idx].subscriptionEnd);
          end.setDate(end.getDate() + (durationDays || 30));
          users[idx].subscriptionEnd = end.toISOString();
        } else {
          users[idx].subscriptionEnd = new Date(Date.now() + (durationDays || 30) * 24 * 60 * 60 * 1000).toISOString();
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

    await writeData('users', users);
    // Send push notification to student
    if (action === 'activate' || action === 'extend') {
      sendFCM(users[idx].id, 'تم تفعيل اشتراكك 🎉', 'مرحباً ' + (users[idx].name || '') + '! تم تفعيل اشتراكك في منصة المُميز.', '/student/subscription');
    } else if (action === 'cancel' || action === 'stop') {
      sendFCM(users[idx].id, 'تم إيقاف اشتراكك', 'عذراً ' + (users[idx].name || '') + '، تم إيقاف اشتراكك في منصة المُميز.', '/student/subscription');
    } else if (action === 'deactivate') {
      sendFCM(users[idx].id, 'تم إلغاء تنشيط اشتراكك', 'عذراً ' + (users[idx].name || '') + '، تم إلغاء تنشيط اشتراكك.', '/student/subscription');
    }
    res.json({ success: true, student: users[idx] });
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

    if (status === 'approved') {
      const users = await readData('users');
      const uidx = users.findIndex(u => u.id === payments[idx].userId);
      if (uidx !== -1) {
        users[uidx].subscriptionStatus = 'active';
        users[uidx].subscriptionStart = new Date().toISOString();
        users[uidx].subscriptionEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await writeData('users', users);
        sendFCM(payments[idx].userId, 'تم تأكيد الدفعة 💳', 'مرحباً! تم تأكيد دفعتك وتفعيل اشتراكك في منصة المُميز. يمكنك الآن مشاهدة جميع المحاضرات.', '/student/subscription');
      }
    }

    await writeData('payments', payments);
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
      code: code || 'CODE-' + Math.random().toString(36).substr(2, 6).toUpperCase(),
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
    var chargeCodes = await fbRead('chargeCodes');
    var chargeArr = [];
    if (chargeCodes) {
      if (Array.isArray(chargeCodes)) chargeArr = chargeCodes;
      else chargeArr = Object.keys(chargeCodes).map(function(k){chargeCodes[k]._key=k; return chargeCodes[k];});
    }
    const codeData = chargeArr.find(function(c) { return c.code === code && c.active !== false; });
    if (!codeData) return res.status(404).json({ error: 'الكود غير صالح' });

    if (new Date(codeData.expiryDate) < new Date()) {
      return res.status(400).json({ error: 'انتهت صلاحية الكود' });
    }

    if (codeData.usedCount >= codeData.maxUses) {
      return res.status(400).json({ error: 'تم استخدام الكود بأقصى عدد مرات' });
    }

    if ((codeData.usedBy || []).includes(req.session.user.id)) {
      return res.status(400).json({ error: 'لقد استخدمت هذا الكود من قبل' });
    }

    codeData.usedCount = (codeData.usedCount || 0) + 1;
    if (!codeData.usedBy) codeData.usedBy = [];
    codeData.usedBy.push(req.session.user.id);

    const users = await readData('users');
    const uidx = users.findIndex(u => u.id === req.session.user.id);
    if (uidx !== -1) {
      var periodWord = { 'شهري': 'شهرياً', 'ترم': 'ترمياً', 'سنوي': 'سنوياً' }[codeData.subscriptionType] || codeData.subscriptionType || '';
      users[uidx].subscriptionStatus = 'active';
      users[uidx].subscriptionStart = new Date().toISOString();
      users[uidx].subscriptionEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      users[uidx].planName = codeData.name || '';
      users[uidx].planPeriod = periodWord;
      await writeData('users', users);
      req.session.user = sessionUser(users[uidx]);
    }

    await fbSet('chargeCodes', chargeArr);
    res.json({ success: true, message: 'تم تفعيل الاشتراك بنجاح' });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.put('/api/admin/charge-codes/:id', requireAdmin, async (req, res) => {
  try {
    var chargeCodes = await fbRead('chargeCodes');
    var chargeArr = Array.isArray(chargeCodes) ? chargeCodes : (chargeCodes ? Object.keys(chargeCodes).map(function(k){chargeCodes[k]._key=k; return chargeCodes[k];}) : []);
    const idx = chargeArr.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الكود غير موجود' });
    Object.assign(chargeArr[idx], req.body);
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
    const { title, course, courseId, color, icon, desc, videoUrl, pdfUrl, videos, pdfFiles, stage, grade, order, isFree } = req.body;
    const newReview = {
      id: Date.now().toString(),
      title: title || 'مراجعة جديدة',
      course: course || '',
      courseId: courseId || '',
      color: color || '#A07200',
      icon: icon || 'fa-book-open',
      date: new Date().toISOString().split('T')[0],
      desc: desc || '',
      videos: videos || (videoUrl ? [{ title: 'فيديو', url: videoUrl }] : []),
      pdfFiles: pdfFiles || (pdfUrl ? [{ title: 'ملف', url: pdfUrl }] : []),
      stage: stage || 'all',
      grade: grade || '',
      order: order || 0,
      isFree: isFree || false
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
    Object.assign(reviews[idx], req.body);
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

app.post('/api/fcm/register', requireAuth, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    console.log('FCM register: user', req.session.user.id, 'token length:', fcmToken ? fcmToken.length : 0);
    const users = await readData('users');
    const idx = users.findIndex(u => u.id === req.session.user.id);
    if (idx !== -1) {
      users[idx].fcmToken = fcmToken;
      await writeData('users', users);
      req.session.user = sessionUser(users[idx]);
      console.log('FCM register: saved for user', req.session.user.id);
    } else {
      console.warn('FCM register: user not found in data store');
    }
    res.json({ success: true });
  } catch (e) {
    console.error('FCM register error:', e.message);
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.post('/api/admin/send-notification', requireAdmin, async (req, res) => {
  try {
    const { title, body, target, targetValue } = req.body;
    const users = await readData('users');
    let recipients = [];

    if (target === 'all') {
      recipients = users.filter(u => u.role === 'student' && u.fcmToken);
    } else if (target === 'grade') {
      recipients = users.filter(u => u.role === 'student' && u.grade === targetValue && u.fcmToken);
    } else if (target === 'stage') {
      recipients = users.filter(u => u.role === 'student' && u.stage === targetValue && u.fcmToken);
    } else if (target === 'student') {
      const user = users.find(u => u.id === targetValue && u.fcmToken);
      if (user) recipients = [user];
    }

    const notifications = await readData('notifications') || [];
    const notif = {
      id: 'notif-' + Date.now(),
      title, body, target, targetValue,
      sentAt: new Date().toISOString(),
      recipientCount: recipients.length
    };
    notifications.push(notif);
    await writeData('notifications', notifications);

    // Send actual FCM push notifications
    let sent = 0;
    for (const u of recipients) {
      try {
        const message = {
          token: u.fcmToken,
          data: { title: title, body: body, url: '/' }
        };
        await admin.messaging().send(message);
        sent++;
      } catch (e) {
        console.error('send-notification FCM error for', u.id, ':', e.code || e.message);
        if (e.code === 'messaging/invalid-registration-token' || e.code === 'messaging/registration-token-not-registered') {
          const idx = users.findIndex(x => x.id === u.id);
          if (idx !== -1) { users[idx].fcmToken = ''; }
        }
      }
    }
    if (recipients.some(u => !u.fcmToken)) await writeData('users', users);

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
    const list = await readData('scheduledNotifications') || [];
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    list[idx].updatedAt = new Date().toISOString();
    await writeData('scheduledNotifications', list);
    res.json({ success: true, notification: list[idx] });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/notifications/check-scheduled — Trigger manual check (for external cron jobs)
app.get('/api/admin/notifications/check-scheduled', requireAdmin, async (req, res) => {
  try {
    const result = await checkScheduledNotifications();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===================== Scheduler Engine ===================== */

async function sendScheduledNotification(notif) {
  try {
    const users = await readData('users');
    let recipients = [];

    if (notif.target === 'all') {
      recipients = users.filter(u => u.role === 'student' && u.fcmToken);
    } else if (notif.target === 'grade') {
      recipients = users.filter(u => u.role === 'student' && u.grade === notif.targetValue && u.fcmToken);
    } else if (notif.target === 'stage') {
      recipients = users.filter(u => u.role === 'student' && u.stage === notif.targetValue && u.fcmToken);
    } else if (notif.target === 'student') {
      const user = users.find(u => u.id === notif.targetValue && u.fcmToken);
      if (user) recipients = [user];
    }

    if (!admin.messaging) return { success: false, sentCount: 0, error: 'FCM غير متاح' };

    let sent = 0;
    for (const u of recipients) {
      try {
        const message = { token: u.fcmToken, data: { title: notif.title, body: notif.body, url: '/' } };
        await admin.messaging().send(message);
        sent++;
      } catch (e) {
        console.error('scheduled-notification FCM error for', u.id, ':', e.code || e.message);
        if (e.code === 'messaging/invalid-registration-token' || e.code === 'messaging/registration-token-not-registered') {
          const idx = users.findIndex(x => x.id === u.id);
          if (idx !== -1) { users[idx].fcmToken = ''; }
        }
      }
    }
    if (recipients.some(u => !u.fcmToken)) await writeData('users', users);

    // Also log to notifications history (same as instant)
    const notifications = await readData('notifications') || [];
    notifications.push({
      id: notif.id,
      title: notif.title,
      body: notif.body,
      target: notif.target,
      targetValue: notif.targetValue,
      sentAt: new Date().toISOString(),
      recipientCount: recipients.length,
      scheduled: true
    });
    await writeData('notifications', notifications);

    return { success: true, sentCount: sent, error: null };
  } catch (e) {
    console.error('sendScheduledNotification error:', e.message);
    return { success: false, sentCount: 0, error: e.message };
  }
}

async function checkScheduledNotifications() {
  try {
    var list = await readData('scheduledNotifications') || [];
    var now = new Date();
    var due = [];

    for (var i = 0; i < list.length; i++) {
      if (list[i].status === 'Pending' && new Date(list[i].scheduledAt) <= now) {
        due.push(list[i]);
      }
    }

    if (!due.length) return { checked: true, processed: 0 };

    var processed = 0;
    for (var di = 0; di < due.length; di++) {
      var notif = due[di];

      // Re-read to check if still Pending (another request might have handled it)
      var fresh = await readData('scheduledNotifications') || [];
      var idx = -1;
      for (var fi = 0; fi < fresh.length; fi++) {
        if (fresh[fi].id === notif.id) { idx = fi; break; }
      }
      if (idx === -1 || fresh[idx].status !== 'Pending') continue;

      fresh[idx].status = 'Sending';
      await writeData('scheduledNotifications', fresh);

      var result = await sendScheduledNotification(notif);
      fresh[idx].status = result.success ? 'Sent' : 'Failed';
      fresh[idx].sentAt = result.success ? new Date().toISOString() : null;
      fresh[idx].error = result.error || null;
      await writeData('scheduledNotifications', fresh);
      processed++;
    }
    return { checked: true, processed: processed };
  } catch (e) {
    console.error('checkScheduledNotifications error:', e.message);
    return { checked: true, processed: 0, error: e.message };
  }
}

// Run scheduler every 30 seconds
const SCHEDULER_INTERVAL = 30000;
let schedulerTimer = null;

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  console.log('[scheduler] Starting scheduled notifications checker every ' + (SCHEDULER_INTERVAL / 1000) + 's');
  schedulerTimer = setInterval(() => {
    checkScheduledNotifications().then(r => {
      if (r.processed > 0) console.log('[scheduler] Processed ' + r.processed + ' scheduled notification(s)');
    });
  }, SCHEDULER_INTERVAL);
  // Also run once immediately after startup
  setTimeout(() => {
    checkScheduledNotifications().then(r => {
      if (r.processed > 0) console.log('[scheduler] Initial check processed ' + r.processed + ' notification(s)');
    });
  }, 5000);
}

startScheduler();

// Scheduler check is now triggered exclusively by cron-job.org hitting /api/cron/check-scheduled
// (The admin page and middleware are NOT used to avoid duplicate processing)

// Public cron endpoint for Vercel Cron Jobs (x-vercel-cron) / cron-job.org (?key=SECRET)
app.get('/api/cron/check-scheduled', async function(req, res) {
  var isVercelCron = req.headers['x-vercel-cron'];
  var secret = process.env.CRON_SECRET;
  if (!isVercelCron && secret && req.query.key !== secret) return res.status(403).json({ error: 'Forbidden' });
  try {
    var result = await checkScheduledNotifications();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/test-fcm', requireAdmin, async (req, res) => {
  try {
    const users = await readData('users');
    const students = users.filter(u => u.role === 'student' && u.fcmToken);
    const allStudentCount = users.filter(u => u.role === 'student').length;
    const userTokens = students.map(u => ({ id: u.id, name: u.name, token: (u.fcmToken || '').slice(0, 20) + '...' }));
    // Check apiKey is set
    const apiKeySet = !!process.env.FIREBASE_API_KEY;
    const apiKeyPreview = process.env.FIREBASE_API_KEY ? process.env.FIREBASE_API_KEY.slice(0, 10) + '...' : 'NOT SET';
    let fcmStatus = 'unknown';
    let fcmError = null;
    try {
      if (admin.messaging) {
        fcmStatus = 'admin.messaging() available';
        const testMsg = { token: 'test', data: { title: 't', body: 't', url: '/' } };
        JSON.stringify(testMsg);
        fcmStatus += ' | can stringify test message';
      }
    } catch (e) { fcmError = e.message; }
    const adminUser = users.find(u => u.role === 'admin');
    // Try a direct test call to FCM to see if credentials work
    let fcmCredsOk = false;
    let fcmCredsError = null;
    try {
      const testMsg2 = { token: 'FAKE_TOKEN_FOR_TEST', data: { title: 't', body: 't', url: '/' } };
      await admin.messaging().send(testMsg2);
    } catch (e) {
      fcmCredsError = e.code || e.message;
      if (e.code === 'messaging/invalid-argument' || e.code === 'messaging/invalid-registration-token' || (e.message && e.message.indexOf('token') !== -1)) {
        fcmCredsOk = true;
      }
    }
    res.json({
      success: true,
      totalStudents: allStudentCount,
      studentCount: students.length,
      userTokens,
      apiKeySet,
      apiKeyPreview,
      vapidKeySet: !!process.env.FIREBASE_VAPID_KEY,
      adminFcmTokenSet: !!(adminUser && adminUser.fcmToken),
      fcmCredsOk: fcmCredsOk,
      fcmCredsError: fcmCredsError
    });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
  }
});

app.get('/api/admin/test-send-fcm', requireAdmin, async (req, res) => {
  try {
    const users = await readData('users');
    const adminUser = users.find(u => u.role === 'admin' && u.fcmToken);
    if (!adminUser) return res.json({ success: false, error: 'Admin has no FCM token' });
    const message = { token: adminUser.fcmToken, data: { title: 'Test', body: 'This is a test notification', url: '/' } };
    try {
      const result = await admin.messaging().send(message);
      res.json({ success: true, result: result });
    } catch (e) {
      res.json({ success: false, error: e.code || e.message, fullError: e.message });
    }
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
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

app.post('/api/admin/upload-note-file', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });
    const fs = require('fs');
    const dir = path.join(__dirname, 'uploads', 'notes');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(req.file.originalname) || '.pdf';
    const filename = 'note-' + Date.now() + ext;
    fs.writeFileSync(path.join(dir, filename), req.file.buffer);
    res.json({ success: true, url: '/uploads/notes/' + filename });
  } catch (e) {
    res.status(500).json({ error: 'تعذر إتمام العملية، حاول مرة أخرى.' });
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
    const users = await readData('users');
    const user = users.find(u => u.id === req.session.user.id);
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
  var state = (req.session.user ? req.session.user.id || req.session.user.uid : '') + '|' + Date.now();
  var url = zoom.getAuthorizeUrl(state);
  res.redirect(url);
});

// GET /auth/zoom/callback — Handle Zoom OAuth callback
app.get('/auth/zoom/callback', async (req, res) => {
  try {
    var code = req.query.code;
    var error = req.query.error;
    if (error) return res.status(400).send('تم رفض الإذن من Zoom: ' + error);
    if (!code) return res.status(400).send('رمز الترخيص مفقود');

    await zoom.completeOAuth(code);
    res.redirect('/admin/settings?zoom=connected');
  } catch (e) {
    console.error('Zoom OAuth callback error:', e.message);
    res.status(500).send('فشل ربط حساب Zoom: ' + e.message);
  }
});

// POST /auth/zoom/disconnect — Disconnect teacher's Zoom account
app.post('/auth/zoom/disconnect', requireAdmin, async (req, res) => {
  try {
    await zoom.disconnect();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/zoom/status — Get Zoom connection status
app.get('/api/zoom/status', requireAdmin, async (req, res) => {
  try {
    var configured = zoom.isConfigured();
    if (!configured) return res.json({ connected: false, configured: false });
    var status = await zoom.getStatus();
    res.json({ ...status, configured: true });
  } catch (e) {
    res.status(500).json({ error: e.message, connected: false, configured: zoom.isConfigured() });
  }
});

// GET /api/zoom/profile — Get Zoom user profile
app.get('/api/zoom/profile', requireAdmin, async (req, res) => {
  try {
    var status = await zoom.getStatus();
    if (!status.connected) return res.json({ connected: false });
    res.json({ connected: true, userName: status.userName, userEmail: status.userEmail, userAvatar: status.userAvatar, connectedAt: status.connectedAt });
  } catch (e) {
    res.status(500).json({ connected: false, error: e.message });
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
      try { zoomSignature = zoom.generateSignature(session.meetingId, 0); } catch(e) {}
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
    res.status(500).send('خطأ في تحميل الحصة: ' + e.message);
  }
});

// GET /zoom-embed/:id — Clean Zoom Meeting SDK page (no site CSS, embedded in iframe)
app.get('/zoom-embed/:id', requireStudentOrGuest, async (req, res) => {
  try {
    var sessions = await readData('liveSessions') || [];
    var session = sessions.find(function(s) { return s.id === req.params.id; });
    if (!session) return res.status(404).send('الحصة غير موجودة');
    var zoomSignature = '';
    if (session.meetingId && zoom.isConfigured()) {
      try { zoomSignature = zoom.generateSignature(session.meetingId, 0); } catch(e) {}
    }
    // Override CSP to allow framing from same origin
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Content-Security-Policy',
      "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://source.zoom.us https://*.zoom.us https://zoom.us; " +
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
      sdkKey: process.env.ZOOM_CLIENT_ID || '',
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
    res.json(list);
  } catch(e) {
    res.status(500).json({ error: e.message });
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
      var status = await zoom.getStatus();
      if (!status.connected) {
        return res.status(400).json({ error: 'يجب ربط حساب Zoom أولاً من صفحة الإعدادات.' });
      }
      try {
        zoomResult = await zoom.createMeeting({
          title: title,
          startTime: startTime,
          duration: parseInt(duration) || 60,
          password: password || '',
          allowJoinBeforeTeacher: !!allowJoinBeforeTeacher,
          waitingRoom: !!waitingRoom,
          recording: !!recording
        });
      } catch (ze) {
        return res.status(500).json({ error: 'فشل إنشاء اجتماع Zoom: ' + ze.message });
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
      notifyAt: notifyAt || '',
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
      var allUsers = await readData('users') || [];
      var stageMap = { 'إعدادي': 'إعدادية', 'ثانوي': 'ثانوية' };
      var s = sessions[idx];
      var recipients = [];
      if (s.grade) {
        recipients = allUsers.filter(function(u) { return u.role === 'student' && u.grade === s.grade && u.fcmToken; });
      } else if (s.stage) {
        var cs = stageMap[s.stage] || s.stage;
        recipients = allUsers.filter(function(u) { return u.role === 'student' && u.stage === cs && u.fcmToken; });
      }
      var startSent = 0;
      for (var ri = 0; ri < recipients.length; ri++) {
        try {
          var msg = {
            token: recipients[ri].fcmToken,
            data: { title: '📺 الحصة المباشرة بدأت الآن!', body: (s.title || 'حصة مباشرة') + ' - اضغط للانضمام', url: '/student/live-session/' + s.id, click_action: 'FLUTTER_NOTIFICATION_CLICK' }
          };
          if (admin.messaging) { await admin.messaging().send(msg); startSent++; }
        } catch (fcmErr) {
          console.error('[start] FCM error:', fcmErr.code || fcmErr.message);
          if (fcmErr.code === 'messaging/invalid-registration-token' || fcmErr.code === 'messaging/registration-token-not-registered') {
            var uidx = allUsers.findIndex(function(x) { return x.id === recipients[ri].id; });
            if (uidx !== -1) { allUsers[uidx].fcmToken = ''; }
          }
        }
      }
      // Mark notified so cron doesn't send a duplicate "about to start" notification
      if (startSent > 0) {
        sessions[idx].notified = true;
        await writeData('liveSessions', sessions);
        // Save to notifications center
        var startNotifs = await readData('notifications') || [];
        startNotifs.push({
          id: 'live-start-' + s.id + '-' + Date.now(),
          title: '📺 الحصة المباشرة بدأت الآن!',
          body: (s.title || 'حصة مباشرة') + ' - اضغط للانضمام',
          target: s.grade ? 'grade' : 'stage',
          targetValue: s.grade || (stageMap[s.stage] || s.stage),
          sentAt: new Date().toISOString(),
          type: 'live_session_start',
          sessionId: s.id,
          sessionTitle: s.title
        });
        await writeData('notifications', startNotifs);
      }
      await writeData('users', allUsers);
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
        await zoom.endMeeting(sessions[idx].meetingId);
      } catch (ze) {
        console.error('Zoom end meeting failed:', ze.message);
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
    res.status(500).json({ error: e.message });
  }
});

// GET /api/debug/student-sessions — Debug endpoint for students (no auth)
app.get('/api/debug/student-sessions', async (req, res) => {
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message, sessions: [], total: 0 });
  }
});

// GET /api/live-sessions/:id — Get a single live session details
app.get('/api/live-sessions/:id', requireStudentOrGuest, async (req, res) => {
  try {
    var sessions = await readData('liveSessions') || [];
    var session = sessions.find(function(s) { return s.id === req.params.id; });
    if (!session) return res.status(404).json({ error: 'الحصة غير موجودة' });
    // Generate signature for Zoom Meeting SDK
    var signature = '';
    var sdkKey = process.env.ZOOM_CLIENT_ID || '';
    if (session.meetingId && zoom.isConfigured()) {
      try {
        signature = zoom.generateSignature(session.meetingId, 0);
      } catch(e) {}
    }
    res.json({ session: session, signature: signature, sdkKey: sdkKey });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/live-sessions/:id/attendance — Record attendance (join/leave)
app.post('/api/live-sessions/:id/attendance', requireStudentOrGuest, async (req, res) => {
  try {
    var userId = req.session.user ? (req.session.user.id || req.session.user.uid) : 'guest';
    var { action } = req.body; // 'join' or 'leave'
    if (!action) return res.status(400).json({ error: 'action مطلوب' });

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
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/live-sessions/:id/attendance — Get attendance for a session
app.get('/api/admin/live-sessions/:id/attendance', requireAdmin, async (req, res) => {
  try {
    var snap = await admin.database().ref('liveSessionAttendance/' + req.params.id).once('value');
    var val = snap.val() || {};
    var users = await readData('users');
    var list = Object.keys(val).map(function(uid) {
      var u = users.find(function(x) { return x.id === uid || x.uid === uid; });
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
    res.status(500).json({ error: e.message });
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
  if (req.query.secret !== (process.env.CRON_SECRET || 'almumayaz-cron-2024')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    if (!admin.messaging) {
      console.error('[cron] admin.messaging is NOT available');
      return res.json({ success: false, sent: 0, error: 'FCM not available' });
    }
    var sessions = await readData('liveSessions') || [];
    var users = await readData('users') || [];
    var stageMap = { 'إعدادي': 'إعدادية', 'ثانوي': 'ثانوية' };
    var now = new Date().toISOString();
    var sent = 0;
    for (var si = 0; si < sessions.length; si++) {
      var s = sessions[si];
      if (!s.notifyAt || s.notified) continue;
      if (s.notifyAt > now) continue;
      if (s.status !== 'Scheduled') continue;
      var recipients = [];
      if (s.grade) {
        recipients = users.filter(function(u) {
          return u.role === 'student' && u.grade === s.grade && u.fcmToken;
        });
      } else if (s.stage) {
        var cs = stageMap[s.stage] || s.stage;
        recipients = users.filter(function(u) {
          return u.role === 'student' && u.stage === cs && u.fcmToken;
        });
      }
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
        try {
          var msg = {
            token: recipients[ri].fcmToken,
            data: {
              title: '🔔 الحصة المباشرة على وشك البدء',
              body: (s.title || 'حصة مباشرة') + ' ستبدأ قريباً - اضغط للانضمام!',
              url: '/student/live-session/' + s.id,
              click_action: 'FLUTTER_NOTIFICATION_CLICK'
            }
          };
          await admin.messaging().send(msg);
          sessionSent++;
        } catch (fcmErr) {
          console.error('[cron] FCM error for', recipients[ri].id, ':', fcmErr.code || fcmErr.message);
          if (fcmErr.code === 'messaging/invalid-registration-token' || fcmErr.code === 'messaging/registration-token-not-registered') {
            var uidx = users.findIndex(function(x) { return x.id === recipients[ri].id; });
            if (uidx !== -1) { users[uidx].fcmToken = ''; }
          }
        }
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
      await writeData('users', users);
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
    res.status(500).json({ error: e.message });
  }
});

// Debug endpoint to inspect sessions
app.get('/api/debug/notifications', async (req, res) => {
  try {
    var sessions = await readData('liveSessions') || [];
    var users = await readData('users') || [];
    var now = new Date().toISOString();
    var stageMap = { 'إعدادي': 'إعدادية', 'ثانوي': 'ثانوية' };
    var info = sessions.map(function(s) {
      var shouldNotify = !!(s.notifyAt && !s.notified && s.notifyAt <= now);
      var recipients = [];
      if (s.grade) {
        recipients = users.filter(function(u) {
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
        allStudentsWithFCM: users.filter(function(u) { return u.role === 'student' && u.fcmToken; }).map(function(u) {
          return { id: u.id, grade: u.grade, stage: u.stage, fcmToken: (u.fcmToken || '').slice(0,20)+'...' };
        })
      };
    });
    res.json({ now: now, sessions: info, totalSessions: sessions.length, totalStudentsWithFCM: users.filter(function(u){return u.role==='student'&&u.fcmToken;}).length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Global error handler
app.use(function(err, req, res, next) {
  console.error('[ERROR]', req.method, req.url, err.stack || err.message || err);
  if (res.headersSent) return;
  res.status(500).send('خطأ في الخادم: ' + (err.message || ''));
});

module.exports = app;
