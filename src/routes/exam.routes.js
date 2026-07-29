const express = require('express');
const router = express.Router();
const examCtrl = require('../controllers/exam.controller');

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.session?.user) return next();
  return res.status(401).json({ error: 'Authentication required' });
}

router.post('/start', requireAuth, examCtrl.start);
router.post('/sync', requireAuth, examCtrl.sync);
router.post('/save-answers', requireAuth, examCtrl.saveAnswers);
router.post('/submit', requireAuth, examCtrl.submit);
router.post('/grade', requireAuth, examCtrl.grade);

module.exports = router;
