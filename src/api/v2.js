const express = require('express');
const router = express.Router();
const services = require('../services');
const { AppError } = require('../services/_base');

// ── V2 API Logger (console only — Vercel filesystem is read-only) ──
function v2Log(entry) {
  const { method, url, status, duration, error, userId } = entry;
  console.log(JSON.stringify({ ts: new Date().toISOString(), type: 'v2-api', method, url, status, duration, error: error || null, userId: userId || null }));
}

function wrap(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// Request logging middleware
router.use((req, res, next) => {
  const start = Date.now();
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    const duration = Date.now() - start;
    const userId = req.session?.user?.id || req.session?.user?.email || 'anonymous';
    const entry = { method: req.method, url: req.originalUrl, status: res.statusCode, duration, userId };
    if (res.statusCode >= 400) entry.error = body?.error || body?.message || '';
    v2Log(entry);
    return originalJson(body);
  };
  next();
});

function adminOnly(req, res, next) {
  if (!req.session?.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function authOnly(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function ownDataOnly(req, res, next) {
  const sessionId = req.session?.user?.id;
  const targetId = req.params.userId;
  const isAdmin = req.session?.user?.role === 'admin';
  if (!isAdmin && sessionId && targetId && sessionId !== targetId) {
    return res.status(403).json({ error: 'Forbidden: can only access your own data' });
  }
  next();
}

function userId(req) {
  return req.session?.user?.id;
}

// ── Courses (public read, admin write) ──
router.get('/courses', wrap(async (req, res) => {
  const { stage, grade, active, limit: rawLimit } = req.query;
  const opts = { limit: rawLimit ? parseInt(rawLimit) : 50 };
  let result;
  if (grade) result = await services.CourseService.getByGrade(grade);
  else if (stage) result = await services.CourseService.getByStage(stage);
  else if (active) result = await services.CourseService.getActive();
  else result = await services.CourseService.list({}, opts);
  res.json(result);
}));

router.get('/courses/:id', wrap(async (req, res) => {
  const full = req.query.full === 'true';
  const result = full ? await services.CourseService.getFull(req.params.id) : await services.CourseService.get(req.params.id);
  res.json(result);
}));

router.get('/courses/:id/tree', wrap(async (req, res) => {
  const tree = await services.CourseService.getCourseTree(req.params.id);
  res.json(tree);
}));

router.post('/courses', adminOnly, wrap(async (req, res) => {
  const course = await services.courseService.create(req.body, userId(req));
  res.status(201).json(course);
}));

router.put('/courses/:id', adminOnly, wrap(async (req, res) => {
  const course = await services.courseService.update(req.params.id, req.body, userId(req));
  res.json(course);
}));

router.delete('/courses/:id', adminOnly, wrap(async (req, res) => {
  await services.courseService.delete(req.params.id, userId(req));
  res.json({ ok: true });
}));

// ── Lessons ──
router.get('/courses/:courseId/lessons', wrap(async (req, res) => {
  const lessons = await services.lessonService.list({ courseId: req.params.courseId });
  res.json(lessons);
}));

router.get('/lessons/:id', wrap(async (req, res) => {
  const lesson = await services.lessonService.get(req.params.id);
  const videos = await services.videoService.list({ lessonId: lesson.id });
  const files = await services.fileService.list({ lessonId: lesson.id });
  res.json({ ...lesson, videos, files });
}));

// ── Users (admin list, self/profile with auth) ──
router.get('/users', adminOnly, wrap(async (req, res) => {
  const { role, limit: rawLimit } = req.query;
  const opts = { limit: rawLimit ? parseInt(rawLimit) : 50 };
  const users = role ? await services.UserService.getByRole(role) : await services.UserService.list({}, opts);
  res.json(users);
}));

router.get('/users/:id', authOnly, ownDataOnly, wrap(async (req, res) => {
  const withProfile = req.query.profile === 'true';
  const user = withProfile ? await services.UserService.getProfile(req.params.id) : await services.UserService.get(req.params.id);
  res.json(user);
}));

router.get('/users/:id/enrollments', authOnly, ownDataOnly, wrap(async (req, res) => {
  const enrollments = await services.EnrollmentService.getEnrolledCourses(req.params.id);
  res.json(enrollments);
}));

// ── Enrollments ──
router.post('/enrollments', adminOnly, wrap(async (req, res) => {
  const { userId, courseId } = req.body;
  if (!userId || !courseId) {
    return res.status(400).json({ error: 'userId and courseId are required' });
  }
  const enrollment = await services.EnrollmentService.enroll(userId, courseId);
  res.status(201).json(enrollment);
}));

router.get('/enrollments', adminOnly, wrap(async (req, res) => {
  const { userId, courseId, limit: rawLimit } = req.query;
  const opts = { limit: rawLimit ? parseInt(rawLimit) : 50 };
  let result;
  if (userId && courseId) result = await services.enrollmentService.findByUserAndCourse(userId, courseId);
  else if (userId) result = await services.EnrollmentService.getEnrolledCourses(userId);
  else if (courseId) result = await services.EnrollmentService.getEnrolledStudents(courseId);
  else result = await services.enrollmentService.list({}, opts);
  res.json(result || []);
}));

router.delete('/enrollments/:id', adminOnly, wrap(async (req, res) => {
  await services.enrollmentService.delete(req.params.id, userId(req));
  res.json({ ok: true });
}));

// ── Progress ──
router.get('/progress/:userId/:courseId', authOnly, ownDataOnly, wrap(async (req, res) => {
  const progress = await services.ProgressService.getDetailedProgress(req.params.userId, req.params.courseId);
  res.json(progress);
}));

router.post('/progress/lesson', authOnly, wrap(async (req, res) => {
  const { courseId, lessonId } = req.body;
  if (!courseId || !lessonId) {
    return res.status(400).json({ error: 'courseId and lessonId are required' });
  }
  const result = await services.ProgressService.completeLesson(userId(req), courseId, lessonId);
  res.json(result);
}));

router.post('/progress/heartbeat', authOnly, wrap(async (req, res) => {
  const { courseId, lessonId, watchTime } = req.body;
  await services.ProgressService.updateWatchTime(userId(req), courseId, lessonId, watchTime || 0);
  res.json({ ok: true });
}));

router.get('/progress/:userId/:courseId/certificate', authOnly, ownDataOnly, wrap(async (req, res) => {
  const cert = await services.ProgressService.getCertificateData(req.params.userId, req.params.courseId);
  res.json(cert);
}));

// ── Quizzes ──
router.get('/quizzes/:id', authOnly, wrap(async (req, res) => {
  const withQuestions = req.query.questions === 'true';
  const quiz = withQuestions ? await services.QuizService.getWithQuestions(req.params.id) : await services.quizService.get(req.params.id);
  res.json(quiz);
}));

router.post('/quizzes/:id/grade', authOnly, wrap(async (req, res) => {
  if (!req.body.answers || !Array.isArray(req.body.answers)) {
    return res.status(400).json({ error: 'answers array is required' });
  }
  const result = await services.QuizService.gradeAttempt(req.params.id, userId(req), req.body.answers);
  res.json(result);
}));

router.get('/quizzes/:id/attempts', authOnly, wrap(async (req, res) => {
  const attempts = await services.QuizService.getUserAttempts(userId(req), req.params.id);
  res.json(attempts);
}));

// ── Payments ──
router.get('/payments', adminOnly, wrap(async (req, res) => {
  const { userId, limit: rawLimit } = req.query;
  const opts = { limit: rawLimit ? parseInt(rawLimit) : 50 };
  const result = userId ? await services.paymentService.list({ userId }) : await services.paymentService.list({}, opts);
  res.json(result);
}));

router.post('/payments', authOnly, wrap(async (req, res) => {
  const payment = await services.PaymentService.recordPayment(userId(req), req.body);
  res.status(201).json(payment);
}));

router.put('/payments/:id/approve', adminOnly, wrap(async (req, res) => {
  const payment = await services.PaymentService.approvePayment(req.params.id, userId(req));
  res.json(payment);
}));

router.put('/payments/:id/reject', adminOnly, wrap(async (req, res) => {
  const payment = await services.PaymentService.rejectPayment(req.params.id, req.body.reason, userId(req));
  res.json(payment);
}));

router.get('/payments/revenue', adminOnly, wrap(async (req, res) => {
  const revenue = await services.PaymentService.getRevenue();
  res.json({ revenue });
}));

// ── Live Sessions ──
router.get('/live-sessions', wrap(async (req, res) => {
  const { status, limit: rawLimit } = req.query;
  const opts = { limit: rawLimit ? parseInt(rawLimit) : 50 };
  let result;
  if (status === 'upcoming') result = await services.LiveSessionService.getUpcoming();
  else if (status === 'live') result = await services.LiveSessionService.getLive();
  else if (status === 'ended') result = await services.LiveSessionService.getEnded();
  else result = await services.LiveSessionService.list({}, opts);
  res.json(result);
}));

router.put('/live-sessions/:id/start', adminOnly, wrap(async (req, res) => {
  const session = await services.LiveSessionService.startSession(req.params.id);
  res.json(session);
}));

router.put('/live-sessions/:id/end', adminOnly, wrap(async (req, res) => {
  const session = await services.LiveSessionService.endSession(req.params.id);
  res.json(session);
}));

// ── Settings ──
router.get('/settings', adminOnly, wrap(async (req, res) => {
  const settings = await services.SettingService.getSettings();
  res.json(settings);
}));

router.put('/settings', adminOnly, wrap(async (req, res) => {
  const updated = await services.SettingService.updateSettings(req.body, userId(req));
  res.json(updated);
}));

router.get('/settings/semester', wrap(async (req, res) => {
  const semester = await services.SettingService.getSemester();
  res.json({ semester });
}));

// ── Notifications (admin) ──
router.get('/notifications', adminOnly, wrap(async (req, res) => {
  const { limit: rawLimit } = req.query;
  const opts = { orderBy: 'sentAt', order: 'desc', limit: rawLimit ? parseInt(rawLimit) : 50 };
  const notifs = await services.notificationService.list({}, opts);
  res.json(notifs);
}));

// ── Announcements ──
router.get('/announcements', wrap(async (req, res) => {
  const { limit: rawLimit } = req.query;
  const opts = { orderBy: 'date', order: 'desc', limit: rawLimit ? parseInt(rawLimit) : 50 };
  const announcements = await services.announcementService.list({}, opts);
  res.json(announcements);
}));

// ── Subscriptions ──
router.get('/subscriptions', wrap(async (req, res) => {
  const { limit: rawLimit } = req.query;
  const subs = await services.subscriptionService.list({}, { limit: rawLimit ? parseInt(rawLimit) : 50 });
  res.json(subs);
}));

// ── Tickets ──
router.post('/tickets', wrap(async (req, res) => {
  const data = { ...req.body };
  if (userId(req)) data.userId = userId(req);
  const ticket = await services.ticketService.create(data, userId(req));
  res.status(201).json(ticket);
}));

router.get('/tickets', adminOnly, wrap(async (req, res) => {
  const { limit: rawLimit } = req.query;
  const opts = { orderBy: 'createdAt', order: 'desc', limit: rawLimit ? parseInt(rawLimit) : 50 };
  const tickets = await services.ticketService.list({}, opts);
  res.json(tickets);
}));

router.put('/tickets/:id', adminOnly, wrap(async (req, res) => {
  const ticket = await services.ticketService.update(req.params.id, req.body, userId(req));
  res.json(ticket);
}));

// ── Charge Codes ──
router.get('/charge-codes', adminOnly, wrap(async (req, res) => {
  const { limit: rawLimit } = req.query;
  const codes = await services.chargeCodeService.list({}, { limit: rawLimit ? parseInt(rawLimit) : 50 });
  res.json(codes);
}));

router.post('/charge-codes', adminOnly, wrap(async (req, res) => {
  const code = await services.chargeCodeService.create(req.body, userId(req));
  res.status(201).json(code);
}));

// ── Reviews ──
router.get('/reviews', wrap(async (req, res) => {
  const { courseId, limit: rawLimit } = req.query;
  const opts = { limit: rawLimit ? parseInt(rawLimit) : 50 };
  const reviews = courseId
    ? await services.reviewService.list({ courseId })
    : await services.reviewService.list({}, { orderBy: 'order', ...opts });
  res.json(reviews);
}));

// ── Notes (student) ──
router.get('/notes', authOnly, wrap(async (req, res) => {
  const notes = await services.noteService.list({ userId: userId(req) });
  res.json(notes);
}));

router.post('/notes', authOnly, wrap(async (req, res) => {
  const note = await services.noteService.create({ ...req.body, userId: userId(req) }, userId(req));
  res.status(201).json(note);
}));

// ── Bookmarks ──
router.get('/bookmarks', authOnly, wrap(async (req, res) => {
  const bookmarks = await services.bookmarkService.list({ userId: userId(req) });
  res.json(bookmarks);
}));

router.post('/bookmarks/toggle', authOnly, wrap(async (req, res) => {
  const { lessonId, courseId } = req.body;
  if (!lessonId) return res.status(400).json({ error: 'lessonId is required' });
  const existing = await services.bookmarkService.list({ userId: userId(req), lessonId });
  if (existing.length > 0) {
    await services.bookmarkService.delete(existing[0].id, userId(req));
    res.json({ bookmarked: false });
  } else {
    await services.bookmarkService.create({ userId: userId(req), lessonId, courseId }, userId(req));
    res.json({ bookmarked: true });
  }
}));

// ── Error handler ──
router.use((err, req, res, next) => {
  console.error('[V2 API]', req.method, req.url, err.message);
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

module.exports = router;
