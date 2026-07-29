const { userService } = require('../services');

async function updateProfile(req, res) {
  const uid = req.user?.id || req.session?.user?.id;
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  const updated = await userService.updateProfile(uid, req.body);
  if (updated.notFound) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json({ success: true, user: updated });
}

async function submitPayment(req, res) {
  const uid = req.user?.id || req.session?.user?.id;
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  const payment = await userService.submitPayment(uid, req.body);
  res.json({ success: true, payment });
}

module.exports = { updateProfile, submitPayment };
