const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

router.post('/register', validate({
  name: [{ required: true, type: 'string', minLength: 2 }],
  email: [{ required: true, type: 'email' }],
  password: [{ required: true, type: 'string', minLength: 6 }],
}), authController.register);

router.post('/login', validate({
  email: [{ required: true, type: 'email' }],
  password: [{ required: true, type: 'string' }],
}), authController.login);

router.post('/logout', authController.logout);
router.post('/refresh', authController.refresh);
router.get('/me', authenticate, authController.me);

module.exports = router;
