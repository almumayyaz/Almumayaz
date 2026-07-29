const { chargeCodeService } = require('../services');

function actorId(req) {
  return req.user?.id || req.session?.user?.id;
}

async function list(req, res) {
  const codes = await chargeCodeService.listChargeCodes();
  res.json(codes);
}

async function getById(req, res) {
  const code = await chargeCodeService.getChargeCode(req.params.id);
  if (!code) return res.status(404).json({ error: 'الكود غير موجود' });
  res.json(code);
}

async function create(req, res) {
  const code = await chargeCodeService.createChargeCode(req.body, actorId(req));
  res.status(201).json({ success: true, code });
}

async function update(req, res) {
  const updated = await chargeCodeService.updateChargeCode(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'الكود غير موجود' });
  res.json({ success: true, code: updated });
}

async function remove(req, res) {
  const result = await chargeCodeService.deleteChargeCode(req.params.id, actorId(req));
  if (result === null) return res.status(404).json({ error: 'الكود غير موجود' });
  res.json({ success: true });
}

async function redeem(req, res) {
  const userId = req.user?.id || req.session?.user?.id;
  if (!userId) return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
  const result = await chargeCodeService.redeemChargeCode(userId, req.body);
  if (result.notFound) return res.status(404).json({ error: 'الكود غير صالح' });
  if (result.expired) return res.status(400).json({ error: 'انتهت صلاحية الكود' });
  if (result.maxUsesReached) return res.status(400).json({ error: 'تم استخدام الكود بأقصى عدد مرات' });
  if (result.userNotFound) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json({ success: true, message: 'تم تفعيل الاشتراك بنجاح' });
}

module.exports = { list, getById, create, update, remove, redeem };
