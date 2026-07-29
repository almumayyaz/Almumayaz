const express = require('express');
const router = express.Router();
const subsCtrl = require('../controllers/subscriptions.controller');
const coursesCtrl = require('../controllers/courses.controller');
const lessonsCtrl = require('../controllers/lessons.controller');
const qbanksCtrl = require('../controllers/questionBanks.controller');
const notesCtrl = require('../controllers/notes.controller');
const reviewsCtrl = require('../controllers/reviews.controller');
const annCtrl = require('../controllers/announcements.controller');
const studentsCtrl = require('../controllers/students.controller');
const subReqCtrl = require('../controllers/subRequests.controller');
const ticketsCtrl = require('../controllers/tickets.controller');
const settingsCtrl = require('../controllers/settings.controller');
const quotesCtrl = require('../controllers/quotes.controller');
const chargeCodesCtrl = require('../controllers/chargeCodes.controller');
const paymentsCtrl = require('../controllers/payments.controller');
const chatCtrl = require('../controllers/chat.controller');

function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  if (req.session?.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin access required' });
}

// ── Subscriptions ──
router.get('/subscriptions', requireAdmin, subsCtrl.list);
router.post('/subscriptions', requireAdmin, subsCtrl.create);
router.put('/subscriptions/:id', requireAdmin, subsCtrl.update);
router.delete('/subscriptions/:id', requireAdmin, subsCtrl.remove);

// ── Courses ──
router.get('/courses', coursesCtrl.list);
router.get('/courses/:id', coursesCtrl.getById);
router.post('/courses', requireAdmin, coursesCtrl.create);
router.put('/courses/:id', requireAdmin, coursesCtrl.update);
router.delete('/courses/:id', requireAdmin, coursesCtrl.remove);

// ── Sections ──
router.post('/courses/:id/sections', requireAdmin, coursesCtrl.createSection);
router.put('/courses/:id/sections/:sectionId', requireAdmin, coursesCtrl.updateSection);
router.delete('/courses/:id/sections/:sectionId', requireAdmin, coursesCtrl.deleteSection);

// ── Course Quiz ──
router.put('/courses/:id/quiz', requireAdmin, coursesCtrl.setQuiz);
router.delete('/courses/:id/quiz', requireAdmin, coursesCtrl.deleteQuiz);

// ── Lessons ──
router.get('/courses/:courseId/lessons', lessonsCtrl.list);
router.post('/courses/:courseId/lessons', requireAdmin, lessonsCtrl.create);
router.put('/courses/:courseId/lessons/:lessonId', requireAdmin, lessonsCtrl.update);
router.delete('/courses/:courseId/lessons/:lessonId', requireAdmin, lessonsCtrl.remove);

// ── Question Banks ──
router.get('/question-banks', requireAdmin, qbanksCtrl.list);
router.get('/question-banks/:id', requireAdmin, qbanksCtrl.getById);
router.post('/question-banks', requireAdmin, qbanksCtrl.create);
router.put('/question-banks/:id', requireAdmin, qbanksCtrl.update);
router.delete('/question-banks/:id', requireAdmin, qbanksCtrl.remove);

// ── Notes ──
router.get('/notes', notesCtrl.list);
router.get('/notes/:id', notesCtrl.getById);
router.post('/notes', requireAdmin, notesCtrl.create);
router.put('/notes/:id', requireAdmin, notesCtrl.update);
router.delete('/notes/:id', requireAdmin, notesCtrl.remove);

// ── Reviews ──
router.get('/reviews', reviewsCtrl.list);
router.get('/reviews/:id', reviewsCtrl.getById);
router.post('/reviews', requireAdmin, reviewsCtrl.create);
router.put('/reviews/:id', requireAdmin, reviewsCtrl.update);
router.delete('/reviews/:id', requireAdmin, reviewsCtrl.remove);
router.put('/reviews/:id/quiz', requireAdmin, reviewsCtrl.setQuiz);
router.delete('/reviews/:id/quiz', requireAdmin, reviewsCtrl.deleteQuiz);

// ── Announcements ──
router.get('/announcements', annCtrl.list);
router.get('/announcements/:id', annCtrl.getById);
router.post('/announcements', requireAdmin, annCtrl.create);
router.put('/announcements/:id', requireAdmin, annCtrl.update);
  router.delete('/announcements/:id', requireAdmin, annCtrl.remove);

// ── Students ──
router.get('/students', studentsCtrl.list);
router.get('/students/:id', studentsCtrl.getById);
router.put('/students/:id', requireAdmin, studentsCtrl.update);
router.delete('/students/:id', requireAdmin, studentsCtrl.remove);
router.put('/students/:id/subscription', requireAdmin, studentsCtrl.updateSubscription);

// ── Subscription Requests ──
router.get('/sub-requests', requireAdmin, subReqCtrl.list);
router.get('/sub-requests/:id', requireAdmin, subReqCtrl.getById);
router.post('/sub-requests/:id/approve', requireAdmin, subReqCtrl.approve);
router.post('/sub-requests/:id/reject', requireAdmin, subReqCtrl.reject);
router.delete('/sub-requests/:id', requireAdmin, subReqCtrl.remove);

// ── Support Tickets ──
router.get('/tickets', requireAdmin, ticketsCtrl.list);
router.get('/tickets/:id', requireAdmin, ticketsCtrl.getById);
router.put('/tickets/:id', requireAdmin, ticketsCtrl.update);
  router.post('/tickets/:id/close', requireAdmin, ticketsCtrl.close);
  router.delete('/tickets/:id', requireAdmin, ticketsCtrl.remove);

// ── Settings ──
router.get('/settings', settingsCtrl.getSettings);
router.get('/settings/:key', settingsCtrl.getByKey);
router.post('/settings', requireAdmin, settingsCtrl.updateSettings);

// ── Quotes ──
router.get('/quotes', quotesCtrl.list);
router.post('/quotes', requireAdmin, quotesCtrl.create);
router.put('/quotes/:id', requireAdmin, quotesCtrl.update);
router.delete('/quotes/:id', requireAdmin, quotesCtrl.remove);

// ── Charge Codes ──
router.get('/charge-codes', requireAdmin, chargeCodesCtrl.list);
router.get('/charge-codes/:id', requireAdmin, chargeCodesCtrl.getById);
router.post('/charge-codes', requireAdmin, chargeCodesCtrl.create);
router.put('/charge-codes/:id', requireAdmin, chargeCodesCtrl.update);
router.delete('/charge-codes/:id', requireAdmin, chargeCodesCtrl.remove);

// ── Payments ──
router.get('/payments', requireAdmin, paymentsCtrl.list);
router.get('/payments/:id', requireAdmin, paymentsCtrl.getById);
router.post('/payments/:id/approve', requireAdmin, paymentsCtrl.approve);
router.post('/payments/:id/reject', requireAdmin, paymentsCtrl.reject);
router.delete('/payments/:id', requireAdmin, paymentsCtrl.remove);

// ── Chat (Admin) ──
router.get('/chats', requireAdmin, chatCtrl.listSessions);
router.get('/chat/:studentId/messages', requireAdmin, chatCtrl.getMessages);
router.post('/chat/:studentId/send', requireAdmin, chatCtrl.sendMessage);
router.put('/chat/:studentId/read', requireAdmin, chatCtrl.markRead);
router.delete('/chat/:studentId', requireAdmin, chatCtrl.deleteChat);

module.exports = router;
