const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
router.use('/auth', authRoutes);

const adminRoutes = require('./admin.routes');
router.use('/admin', adminRoutes);

const studentRoutes = require('./student.routes');
router.use('/student', studentRoutes);

const examRoutes = require('./exam.routes');
router.use('/exam', examRoutes);

// Public: parent invite acceptance (no auth required)
const parentInviteCtrl = require('../controllers/parentInvite.controller');
router.post('/parent/accept-invite', parentInviteCtrl.acceptInvite);

module.exports = router;
