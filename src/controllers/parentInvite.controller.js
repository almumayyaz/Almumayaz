const { parentInviteService } = require('../services');

async function sendInvite(req, res) {
  const uid = req.user?.id || req.session?.user?.id;
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  const result = await parentInviteService.sendInvite(uid, req.body);
  if (result.validationError) return res.status(400).json({ error: 'يرجى إدخال اسم ورقم هاتف ولي الأمر' });
  if (result.existing) return res.json({ success: true, inviteLink: result.inviteLink, parentEmail: result.parentEmail });
  res.json({ success: true, inviteLink: result.inviteLink, invite: result.invite });
}

async function acceptInvite(req, res) {
  const result = await parentInviteService.acceptInvite(req.body);
  if (result.validationError) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  if (result.notFound) return res.status(404).json({ error: 'رابط الدعوة غير صالح أو منتهي الصلاحية' });
  res.json({ success: true, ...(result.message ? { message: result.message } : {}) });
}

module.exports = { sendInvite, acceptInvite };
