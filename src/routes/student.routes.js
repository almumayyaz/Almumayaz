const express = require('express');
const router = express.Router();
const quotesCtrl = require('../controllers/quotes.controller');
const chargeCodesCtrl = require('../controllers/chargeCodes.controller');
const progressCtrl = require('../controllers/progress.controller');
const chatCtrl = require('../controllers/chat.controller');
const profileCtrl = require('../controllers/studentProfile.controller');
const referralCtrl = require('../controllers/referral.controller');
const parentInviteCtrl = require('../controllers/parentInvite.controller');

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.session?.user) return next();
  return res.status(401).json({ error: 'Authentication required' });
}

// ── Quote (public) ──
router.get('/quote', quotesCtrl.random);

// ── Charge Code Redeem ──
router.post('/redeem-code', requireAuth, chargeCodesCtrl.redeem);

// ── Progress ──
router.post('/progress', requireAuth, progressCtrl.markLessonComplete);
router.get('/progress/:courseId', requireAuth, progressCtrl.getProgress);
router.get('/progress', requireAuth, progressCtrl.summary);
router.post('/progress/heartbeat', requireAuth, progressCtrl.heartbeat);

// ── Chat ──
router.get('/chat/messages', requireAuth, chatCtrl.getMessages);
router.post('/chat/send', requireAuth, chatCtrl.sendMessage);
router.put('/chat/read', requireAuth, chatCtrl.markRead);

// ── Profile ──
router.put('/profile', requireAuth, profileCtrl.updateProfile);

// ── Payment ──
router.post('/submit-payment', requireAuth, profileCtrl.submitPayment);

// ── Referral ──
router.post('/apply-referral', requireAuth, referralCtrl.applyReferral);

// ── Parent Invite ──
router.post('/send-parent-invite', requireAuth, parentInviteCtrl.sendInvite);

module.exports = router;
