const { referralService } = require('../services');

async function applyReferral(req, res) {
  const uid = req.user?.id || req.session?.user?.id;
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  const result = await referralService.applyReferral(uid, req.body);
  if (result.invalidCode) return res.status(400).json({ error: 'كود الدعوة غير صالح' });
  if (result.notFound) return res.status(404).json({ error: 'كود الدعوة غير موجود' });
  if (result.selfReferral) return res.status(400).json({ error: 'لا يمكنك استخدام كود دعوتك الشخصي' });
  if (result.userNotFound) return res.status(404).json({ error: 'المستخدم غير موجود' });
  if (result.alreadyUsed) return res.status(400).json({ error: 'لقد استخدمت كود دعوة من قبل' });
  if (result.cooldown) return res.status(400).json({ error: 'يمكنك استخدام كود دعوة جديد بعد ' + result.daysLeft + ' يومًا' });
  res.json({ success: true, discount: result.discount, message: result.message });
}

module.exports = { applyReferral };
