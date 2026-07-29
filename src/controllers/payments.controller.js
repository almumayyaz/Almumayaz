const { paymentService } = require('../services');

function actorId(req) {
  return req.user?.id || req.session?.user?.id;
}

async function list(req, res) {
  const payments = await paymentService.listPayments(req.query);
  res.json(payments);
}

async function getById(req, res) {
  const payment = await paymentService.getPayment(req.params.id);
  if (!payment) return res.status(404).json({ error: 'الدفعة غير موجودة' });
  res.json(payment);
}

async function approve(req, res) {
  const result = await paymentService.approvePayment(req.params.id, actorId(req));
  if (!result) return res.status(404).json({ error: 'الدفعة غير موجودة' });
  res.json({ success: true, payment: result });
}

async function reject(req, res) {
  const result = await paymentService.rejectPayment(req.params.id, req.body, actorId(req));
  if (!result) return res.status(404).json({ error: 'الدفعة غير موجودة' });
  res.json({ success: true, payment: result });
}

async function remove(req, res) {
  const result = await paymentService.deletePayment(req.params.id, actorId(req));
  if (result === null) return res.status(404).json({ error: 'الدفعة غير موجودة' });
  res.json({ success: true });
}

module.exports = { list, getById, approve, reject, remove };
