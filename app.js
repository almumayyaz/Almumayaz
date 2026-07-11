try { require('dotenv').config(); } catch (e) {}

const express = require('express');
const session = require('cookie-session');
const bodyParser = require('body-parser');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { readData, writeData, fbAuth, sendFCM, sendFCMToRole, admin } = require('./firebase-admin');

const app = express();

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(session({
  name: 'lughati_session',
  secret: process.env.SESSION_SECRET || 'lughati-secret-key-2026',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  sameSite: 'lax',
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production'
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const multer = require('multer');
const mammoth = require('mammoth');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function stripBOM(s) {
  if (!s || typeof s !== 'string') return s;
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
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

app.get('/parent-login', (req, res) => {
  if (req.session.user) return req.session.user.role === 'admin' ? res.redirect('/admin') : res.redirect('/student');
  res.render('auth/login', { title: 'تسجيل دخول ولي الأمر - المُميز', error: null, parentLogin: true });
});

app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.currentPath = req.path;
  res.locals.darkMode = req.session.darkMode || false;
  res.locals.isGuest = !!req.session.demoMode;
  res.locals.firebaseConfig = {
    apiKey: stripBOM(process.env.FIREBASE_API_KEY || ''),
    authDomain: stripBOM(process.env.FIREBASE_AUTH_DOMAIN || ''),
    databaseURL: stripBOM(process.env.FIREBASE_DATABASE_URL || ''),
    projectId: stripBOM(process.env.FIREBASE_PROJECT_ID || ''),
    storageBucket: stripBOM(process.env.FIREBASE_STORAGE_BUCKET || ''),
    messagingSenderId: stripBOM(process.env.FIREBASE_MESSAGING_SENDER_ID || ''),
    appId: stripBOM(process.env.FIREBASE_APP_ID || '')
  };
  res.locals.vapidKey = stripBOM(process.env.FIREBASE_VAPID_KEY || '');
  try {
    var appSettings = await readData('settings');
    if (appSettings && typeof appSettings === 'object') {
      res.locals.vodafoneCash = appSettings.vodafoneCash || stripBOM(process.env.VODAFONE_CASH || '01000000000');
      res.locals.instaPay = appSettings.instaPay || stripBOM(process.env.INSTAPAY || 'example@instapay.com');
      res.locals.currentSemester = appSettings.currentSemester || 'all';
    } else {
      res.locals.vodafoneCash = stripBOM(process.env.VODAFONE_CASH || '01000000000');
      res.locals.instaPay = stripBOM(process.env.INSTAPAY || 'example@instapay.com');
      res.locals.currentSemester = 'all';
    }
  } catch (e) {
    res.locals.vodafoneCash = stripBOM(process.env.VODAFONE_CASH || '01000000000');
    res.locals.instaPay = stripBOM(process.env.INSTAPAY || 'example@instapay.com');
    res.locals.currentSemester = 'all';
  }
  next();
});

app.use(refreshSession);

/* ===================== AUTO-MIGRATION ===================== */
(async function autoMigrate() {
  try {
    // Migrate courses: videoUrl → videos[], pdfUrl → pdfFiles[]
    var courses = await readData('courses');
    var coursesChanged = false;
    courses.forEach(function(c) {
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
    var reviews = await readData('reviews');
    var reviewsChanged = false;
    reviews.forEach(function(r) {
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

    req.session.user = user;
    res.json({ success: true, redirect: user.role === 'admin' ? '/admin' : '/student' });
  } catch (e) {
    console.error('Firebase login error:', e);
    res.status(401).json({ error: 'فشل التحقق من الهوية' });
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
      progress: {}
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

    req.session.user = newUser;
    res.json({ success: true, redirect: '/student' });
  } catch (e) {
    console.error('Firebase register error:', e);
    res.status(401).json({ error: 'فشل إنشاء الحساب' });
  }
});

app.post('/api/auth/firebase-admin-login', async (req, res) => {
  try {
    const { idToken } = req.body;
    const decoded = await fbAuth.verifyIdToken(idToken);
    const users = await readData('users');
    const user = users.find(u => u.uid === decoded.uid && u.role === 'admin');
    if (!user) return res.status(403).json({ error: 'غير مصرح بالدخول' });

    req.session.user = user;
    res.json({ success: true, redirect: '/admin' });
  } catch (e) {
    res.status(401).json({ error: 'فشل التحقق من الهوية' });
  }
});

app.get('/', async (req, res) => {
  if (req.session.user) return req.session.user.role === 'admin' ? res.redirect('/admin') : res.redirect('/student');
  const courses = await readData('courses');
  const subscriptions = await readData('subscriptions');
  res.render('public/index', { courses, subscriptions, title: 'المُميز - منصة محمد عفيفي التعليمية' });
});

app.get('/demo', (req, res) => {
  req.session.demoMode = true;
  req.session.user = { name: 'زائر', role: 'guest', grade: '' };
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

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const users = await readData('users');
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) return res.render('auth/login', { title: 'تسجيل الدخول - المُميز', error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
  req.session.user = user;
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
    fcmToken: '', createdAt: new Date().toISOString(), lastLogin: new Date().toISOString(), progress: {}
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
  req.session.user = newUser;
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
  if (subscriptionStage) userStage = subscriptionStage;
  if (userStage) courses = courses.filter(function(c) { return c.stage === userStage || c.stage === 'all'; });
  if (userGrade) courses = courses.filter(function(c) { return c.grade === userGrade || !c.grade; });
  var currentSemester = res.locals.currentSemester || 'all';
  if (currentSemester !== 'all') courses = courses.filter(function(c) { return c.semester === currentSemester || c.semester === 'all'; });
  const announcements = await readData('announcements');
  let progress = {};
  if (!isGuest && req.session.user) {
    const userData = await readData('users');
    const u = userData && userData[req.session.user.uid];
    progress = (u && u.progress) || {};
  }
  res.render('student/dashboard', { courses, announcements, progress, isGuest, title: 'لوحة التحكم - المُميز' });
});

app.get('/student/courses', requireStudentOrGuest, async (req, res) => {
  var courses = await readData('courses');
  const user = req.session.user;
  var userStage = (user && user.stage) || '';
  var userGrade = (user && user.grade) || '';
  var subscriptionStage = (user && user.subscribedStage) || '';
  if (subscriptionStage) userStage = subscriptionStage;
  // Filter by student's stage and grade
  if (userStage) courses = courses.filter(function(c) { return c.stage === userStage || c.stage === 'all'; });
  if (userGrade) courses = courses.filter(function(c) { return c.grade === userGrade || !c.grade; });
  // Filter by current semester
  var currentSemester = res.locals.currentSemester || 'all';
  if (currentSemester !== 'all') courses = courses.filter(function(c) { return c.semester === currentSemester || c.semester === 'all'; });
  res.render('student/courses', { courses, userStage, userGrade, title: 'المحاضرات - المُميز' });
});

app.get('/student/course/:id', requireStudentOrGuest, async (req, res) => {
  const courses = await readData('courses');
  const course = courses.find(c => c.id === req.params.id);
  if (!course) return res.redirect('/student/courses');

  const user = req.session.user;
  const isGuest = req.session.demoMode;
  const isSubscribed = !isGuest && user.subscriptionStatus === 'active' && (!user.subscriptionEnd || new Date(user.subscriptionEnd) > new Date());
  const currentSemester = res.locals.currentSemester || 'all';

  res.render('student/course-detail', {
    course, user, isGuest, isSubscribed, currentSemester,
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

  res.render('student/lesson', {
    course, lesson, user, isGuest, isSubscribed, isFree,
    title: `${lesson.title} - المُميز`
  });
});

app.get('/student/view-pdf/:courseId/:lessonId/:pdfIdx', requireStudentOrGuest, async (req, res) => {
  const courses = await readData('courses');
  const course = courses.find(c => c.id === req.params.courseId);
  if (!course) return res.redirect('/student/courses');
  const lesson = (course.lessons||[]).find(l => l.id === req.params.lessonId);
  if (!lesson) return res.redirect(`/student/course/${course.id}`);
  const idx = parseInt(req.params.pdfIdx);
  if (!lesson.pdfFiles || !lesson.pdfFiles[idx]) return res.redirect(`/student/lesson/${course.id}/${lesson.id}`);

  res.render('student/pdf-viewer', {
    course, lesson, pdfUrl: lesson.pdfFiles[idx].url, pdfTitle: lesson.pdfFiles[idx].title,
    title: `${lesson.pdfFiles[idx].title} - المُميز`
  });
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
  res.render('student/notes', { courses, allNotes, title: 'المذكرات - المُميز' });
});

app.get('/student/reviews', requireStudent, async (req, res) => {
  var reviews = await readData('reviews');
  var courses = await readData('courses');
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
  const reviews = await readData('reviews');
  const review = reviews.find(r => r.id === req.params.id);
  if (!review) return res.redirect('/student/reviews');
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
    res.status(500).json({ error: e.message });
  }
});

app.get('/student/profile', requireStudent, (req, res) => {
  res.render('student/profile', { title: 'حسابي - المُميز' });
});

app.put('/api/student/profile', requireAuth, async (req, res) => {
  try {
    const users = await readData('users');
    const idx = users.findIndex(u => u.id === req.session.user.id);
    if (idx === -1) return res.status(404).json({ error: 'المستخدم غير موجود' });
    Object.assign(users[idx], req.body);
    users[idx].lastLogin = new Date().toISOString();
    await writeData('users', users);
    req.session.user = users[idx];
    res.json({ success: true, user: users[idx] });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    req.session.user = users[uidx];

    res.json({ success: true, discount: 25, message: 'تم تطبيق خصم 25% على جميع خطط الاشتراك!' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===================== CHAT ===================== */

app.get('/student/chat', requireStudent, (req, res) => {
  const user = req.session.user;
  const isGuest = !!req.session.demoMode;
  const chatId = isGuest ? (req.session.guestChatId || 'guest-' + Date.now()) : ('student-' + user.id);
  res.render('student/chat', { user, isGuest, chatId, title: 'اسأل عفيفي - المُميز' });
});

/* ===================== STUDENT SUBSCRIPTION API ===================== */

app.post('/api/student/subscribe', requireAuth, async (req, res) => {
  try {
    const { planName, price, transactionId, paymentMethod } = req.body;
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
      planStage: sub ? (sub.stage || '') : '',
      durationDays: sub ? (sub.durationDays || 30) : 30,
      status: 'pending',
      date: new Date().toISOString(),
      discount: req.session.user.referralDiscount || 0
    };
    subRequests.push(request);
    await writeData('subRequests', subRequests);
    res.json({ success: true, request });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/sub-requests', requireAdmin, async (req, res) => {
  try {
    const subRequests = await readData('subRequests') || [];
    res.json({ success: true, requests: subRequests.reverse() });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/chat/:studentId/messages', requireAdmin, async (req, res) => {
  try {
    const chatId = 'student-' + req.params.studentId;
    const data = await fbRead('chats/' + chatId + '/messages');
    const msgs = data ? Object.keys(data).map(function(k) { var m=data[k]; m._key=k; return m; }).sort(function(a,b){return (a.timestamp||0)-(b.timestamp||0)}) : [];
    res.json({ success: true, messages: msgs });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/chat/:studentId', requireAdmin, async (req, res) => {
  try {
    const chatId = 'student-' + req.params.studentId;
    await fbRemove('chats/' + chatId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/student/chat/read', requireStudent, async (req, res) => {
  try {
    const cid = chatId(req);
    const data = await fbRead('chats/' + cid + '/messages');
    if (!data) return res.json({ success: true });
    Object.keys(data).forEach(function(k) { if (data[k].senderId === 'teacher') data[k].read = true; });
    await fbSet('chats/' + cid + '/messages', data);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/chat/:studentId/read', requireAdmin, async (req, res) => {
  try {
    const chatId = 'student-' + req.params.studentId;
    const data = await fbRead('chats/' + chatId + '/messages');
    if (!data) return res.json({ success: true });
    Object.keys(data).forEach(function(k) { if (data[k].senderId !== 'teacher') data[k].read = true; });
    await fbSet('chats/' + chatId + '/messages', data);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    req.session.user = users[idx];
    res.json({ success: true, progress: users[idx].progress[courseId] });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    const reviews = await readData('reviews');
    const payments = await readData('payments') || [];
    res.render('admin/dashboard', { students, courses, announcements, subscriptions, reviews, payments, title: 'لوحة الإدارة - المُميز' });
  } catch(e) {
    console.error('Admin dashboard error:', e);
    res.status(500).send('خطأ في تحميل لوحة التحكم: ' + e.message);
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
    res.status(500).send('خطأ في تحميل صفحة المحاضرات: ' + e.message);
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
    res.status(500).send('خطأ في تحميل المدفوعات: ' + e.message);
  }
});

app.get('/admin/settings', requireAdmin, async (req, res) => {
  var settings = await readData('settings') || {};
  res.render('admin/settings', {
    currentSemester: settings.currentSemester || 'all',
    vodafoneCash: settings.vodafoneCash || process.env.VODAFONE_CASH || '01000000000',
    instaPay: settings.instaPay || process.env.INSTAPAY || 'example@instapay.com',
    title: 'الإعدادات - الإدارة'
  });
});

app.get('/admin/charge-codes', requireAdmin, async (req, res) => {
  var chargeCodes = await fbRead('chargeCodes');
  if (!chargeCodes) chargeCodes = [];
  if (!Array.isArray(chargeCodes)) chargeCodes = Object.keys(chargeCodes).map(function(k){chargeCodes[k]._key=k; return chargeCodes[k];});
  res.render('admin/charge-codes', { chargeCodes, title: 'أكواد الشحن - الإدارة' });
});

app.get('/admin/announcements', requireAdmin, async (req, res) => {
  const announcements = await readData('announcements');
  res.render('admin/announcements', { announcements, title: 'الإعلانات - الإدارة' });
});

app.get('/admin/send-notification', requireAdmin, (req, res) => {
  res.render('admin/send-notification', { title: 'إرسال إشعار - الإدارة' });
});

app.get('/admin/reviews', requireAdmin, async (req, res) => {
  var allReviews = await readData('reviews');
  var allCourses = await readData('courses');
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    await writeData('courses', courses);
    sendFCMToRole('student', 'محاضرة جديدة تمت إضافتها 🎬', 'تم إضافة محاضرة "' + (title || 'جديدة') + '" في مادة ' + (course.title || '') + '.', '/student/course/' + course.id);
    res.json({ success: true, lesson: newLesson });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/courses/:id/lessons/:lessonId', requireAdmin, async (req, res) => {
  try {
    const courses = await readData('courses');
    const course = courses.find(c => c.id === req.params.id);
    if (!course) return res.status(404).json({ error: 'المادة غير موجودة' });
    const lesson = (course.lessons||[]).find(l => l.id === req.params.lessonId);
    if (!lesson) return res.status(404).json({ error: 'المحاضرة غير موجودة' });
    const { title, description, videos, pdfFiles, duration, order, isFree, guestVisible, sectionId } = req.body;
    if (title !== undefined) lesson.title = title;
    if (description !== undefined) lesson.description = description;
    if (videos !== undefined) lesson.videos = videos;
    if (pdfFiles !== undefined) lesson.pdfFiles = pdfFiles;
    if (duration !== undefined) lesson.duration = duration;
    if (order !== undefined) lesson.order = order;
    if (isFree !== undefined) lesson.isFree = isFree;
    if (guestVisible !== undefined) lesson.guestVisible = guestVisible;
    if (sectionId !== undefined) lesson.sectionId = sectionId;
    await writeData('courses', courses);
    res.json({ success: true, lesson });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===================== ADMIN: FORCE SEED MIGRATION ===================== */

app.post('/api/admin/migrate-seed', requireAdmin, async (req, res) => {
  try {
    const { migrateSeedData, fbDb } = require('./firebase-admin');
    await migrateSeedData();
    res.json({ success: true, message: 'تم ترحيل البيانات بنجاح' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/force-migrate', requireAdmin, async (req, res) => {
  try {
    const { fbDb } = require('./firebase-admin');
    const localStore = require('./data-store');
    const keys = ['courses', 'announcements', 'subscriptions', 'reviews'];
    const results = {};
    for (const key of keys) {
      const local = await localStore.readData(key);
      if (local && fbDb) {
        const data = Array.isArray(local) ? local : Object.values(local);
        await fbDb.ref(key).set(data);
        results[key] = Array.isArray(local) ? local.length : Object.keys(local).length;
        console.log('Force-migrated', key, 'to Firebase');
      }
    }
    // Also migrate courses one by one to ensure lessons are included
    const localCourses = await localStore.readData('courses');
    if (Array.isArray(localCourses) && fbDb) {
      await fbDb.ref('courses').set(localCourses);
      results.courses = localCourses.length + ' courses with lessons';
    }
    res.json({ success: true, message: 'تم فرض الترحيل', results });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

/* ===================== ADMIN API: NOTES (مذكرات) ===================== */

app.post('/api/admin/notes', requireAdmin, async (req, res) => {
  try {
    const notes = await readData('notes');
    const { courseId, title, description, fileUrl, order, isFree } = req.body;
    const newNote = {
      id: 'note-' + Date.now(),
      courseId: courseId || '',
      title: title || 'مذكرة جديدة',
      description: description || '',
      fileUrl: fileUrl || '',
      order: order || 0,
      isFree: isFree || false,
      createdAt: new Date().toISOString()
    };
    notes.push(newNote);
    await writeData('notes', notes);
    res.json({ success: true, note: newNote });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

/* ===================== ADMIN API: QUESTION BANKS (بنوك الأسئلة) ===================== */

app.post('/api/admin/question-banks', requireAdmin, async (req, res) => {
  try {
    const banks = await readData('questionBanks');
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
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/question-banks/:id', requireAdmin, async (req, res) => {
  try {
    const banks = await readData('questionBanks');
    const idx = banks.findIndex(b => b.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'بنك الأسئلة غير موجود' });
    Object.assign(banks[idx], req.body);
    await writeData('questionBanks', banks);
    res.json({ success: true, bank: banks[idx] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/question-banks/:id', requireAdmin, async (req, res) => {
  try {
    const banks = await readData('questionBanks');
    const idx = banks.findIndex(b => b.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'بنك الأسئلة غير موجود' });
    banks.splice(idx, 1);
    await writeData('questionBanks', banks);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

/* ===================== ADMIN API: STUDENT SUBSCRIPTION ===================== */

app.put('/api/admin/students/:id/subscription', requireAdmin, async (req, res) => {
  try {
    const users = await readData('users');
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الطالب غير موجود' });
    const { action, durationDays, stage } = req.body;

    switch (action) {
      case 'activate':
        users[idx].subscriptionStatus = 'active';
        users[idx].subscriptionStart = new Date().toISOString();
        users[idx].subscriptionEnd = new Date(Date.now() + (durationDays || 30) * 24 * 60 * 60 * 1000).toISOString();
        if (stage) users[idx].subscribedStage = stage;
        break;
      case 'deactivate':
        users[idx].subscriptionStatus = 'inactive';
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

/* ===================== ADMIN API: CHARGE CODES ===================== */

app.post('/api/admin/charge-codes', requireAdmin, async (req, res) => {
  try {
    const chargeCodes = await fbRead('chargeCodes') || [];
    const chargeArr = Array.isArray(chargeCodes) ? chargeCodes : Object.keys(chargeCodes).map(function(k){chargeCodes[k]._key=k; return chargeCodes[k];});
    const { code, duration, expiryDays, subscriptionType, value, price, maxUses } = req.body;
    const days = duration || expiryDays || 365;
    const newCode = {
      id: Date.now().toString(),
      code: code || 'CODE-' + Math.random().toString(36).substr(2, 6).toUpperCase(),
      expiryDate: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
      subscriptionType: subscriptionType || 'monthly',
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
    res.status(500).json({ error: e.message });
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
      users[uidx].subscriptionStatus = 'active';
      users[uidx].subscriptionStart = new Date().toISOString();
      users[uidx].subscriptionEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await writeData('users', users);
      req.session.user = users[uidx];
    }

    await fbSet('chargeCodes', chargeArr);
    res.json({ success: true, message: 'تم تفعيل الاشتراك بنجاح' });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

/* ===================== ADMIN API: REVIEWS ===================== */

app.post('/api/admin/reviews', requireAdmin, async (req, res) => {
  try {
    const reviews = await readData('reviews');
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
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  try {
    const reviews = await readData('reviews');
    const idx = reviews.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'المراجعة غير موجودة' });
    Object.assign(reviews[idx], req.body);
    await writeData('reviews', reviews);
    res.json({ success: true, review: reviews[idx] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/reviews/:id/quiz', requireAdmin, async (req, res) => {
  try {
    const reviews = await readData('reviews');
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
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/reviews/:id/quiz', requireAdmin, async (req, res) => {
  try {
    const reviews = await readData('reviews');
    const review = reviews.find(r => r.id === req.params.id);
    if (!review) return res.status(404).json({ error: 'المراجعة غير موجودة' });
    review.quiz = null;
    await writeData('reviews', reviews);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  try {
    const reviews = await readData('reviews');
    const idx = reviews.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'المراجعة غير موجودة' });
    reviews.splice(idx, 1);
    await writeData('reviews', reviews);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
      req.session.user = users[idx];
      console.log('FCM register: saved for user', req.session.user.id);
    } else {
      console.warn('FCM register: user not found in data store');
    }
    res.json({ success: true });
  } catch (e) {
    console.error('FCM register error:', e.message);
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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

module.exports = app;
