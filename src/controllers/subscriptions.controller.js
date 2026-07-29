const { subscriptionService } = require('../services');

async function list(req, res) {
  const subs = await subscriptionService.listSubscriptions();
  res.json(subs);
}

async function create(req, res) {
  const sub = await subscriptionService.createSubscription({ ...req.body, _ip: req.headers['x-forwarded-for'] || req.ip, _ua: req.headers['user-agent'] }, req.user?.id || req.session?.user?.id);
  res.status(201).json({ success: true, subscription: sub });
}

async function update(req, res) {
  const updated = await subscriptionService.updateSubscription(req.params.id, { ...req.body, _ip: req.headers['x-forwarded-for'] || req.ip, _ua: req.headers['user-agent'] }, req.user?.id || req.session?.user?.id);
  if (!updated) return res.status(404).json({ error: 'الباقة غير موجودة' });
  res.json({ success: true, subscription: updated });
}

async function remove(req, res) {
  const result = await subscriptionService.deleteSubscription(req.params.id, req.user?.id || req.session?.user?.id);
  if (result === null) return res.status(404).json({ error: 'الباقة غير موجودة' });
  res.json({ success: true });
}

module.exports = { list, create, update, remove };
