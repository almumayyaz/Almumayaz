const { recordAuditLog, ACTIONS } = require('../utils/auditLog');
const { paymentRepo, userRepo } = require('../repositories');
const { getPrisma } = require('../database');

async function listPayments({ userId, status } = {}) {
  const where = {};
  if (userId) where.userId = userId;
  if (status) where.status = status;
  return paymentRepo.query(where, { orderBy: { date: 'desc' } });
}

async function getPayment(id) {
  const payment = await paymentRepo.get(id);
  if (!payment || payment.deletedAt) return null;
  return payment;
}

async function approvePayment(id, actor) {
  const existing = await paymentRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    await tx.payment.update({ where: { id }, data: { status: 'approved', rejectReason: '' } });
    const user = await tx.user.findUnique({ where: { id: existing.userId } });
    if (user) {
      const endDate = user.subscriptionEnd && new Date(user.subscriptionEnd) > new Date()
        ? new Date(new Date(user.subscriptionEnd).getTime() + 30 * 86400000)
        : new Date(Date.now() + 30 * 86400000);
      await tx.user.update({ where: { id: existing.userId }, data: { subscriptionStatus: 'active', subscriptionStart: new Date(), subscriptionEnd: endDate } });
    }
  });
  await recordAuditLog({ actorId: actor, action: ACTIONS.PAYMENT_APPROVE, entity: 'Payment', entityId: id, ip: existing._ip, userAgent: existing._ua });
  return { ...existing, status: 'approved' };
}

async function rejectPayment(id, { rejectReason }, actor) {
  const existing = await paymentRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  await paymentRepo.update(id, { status: 'rejected', rejectReason: rejectReason || '' });
  await recordAuditLog({ actorId: actor, action: ACTIONS.PAYMENT_REJECT, entity: 'Payment', entityId: id, ip: existing._ip, userAgent: existing._ua });
  return { ...existing, status: 'rejected', rejectReason: rejectReason || '' };
}

async function deletePayment(id, actor) {
  const existing = await paymentRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  await paymentRepo.softDelete(id, actor);
}

module.exports = { listPayments, getPayment, approvePayment, rejectPayment, deletePayment };
