const { recordAuditLog, ACTIONS } = require('../utils/auditLog');
const { subRequestRepo, userRepo, paymentRepo } = require('../repositories');
const { getPrisma } = require('../database');

async function listSubRequests() {
  const requests = await subRequestRepo.query({}, { orderBy: { date: 'desc' } });
  const users = await userRepo.query({}, { select: { id: true, name: true, referralCode: true } });
  const enriched = requests.map(sr => {
    const u = users.find(x => x.id === sr.userId);
    let referredByName = '';
    if (u && u.referredBy) {
      const ref = users.find(x => x.referralCode === u.referredBy || x.id === u.referredBy);
      if (ref) referredByName = ref.name;
    }
    return { ...sr, referredByName };
  });
  return enriched;
}

async function getSubRequest(id) {
  const request = await subRequestRepo.get(id);
  if (!request || request.deletedAt) return null;
  return request;
}

async function approveSubRequest(id, actor) {
  const existing = await subRequestRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    await tx.subRequest.update({ where: { id }, data: { status: 'approved', reviewedBy: actor, reviewedAt: new Date() } });
    const user = await tx.user.findUnique({ where: { id: existing.userId } });
    if (user) {
      const durDays = parseInt(existing.durationDays) || 30;
      const userData = {
        subscriptionStatus: 'active',
        subscriptionStart: new Date(),
        subscriptionEnd: new Date(Date.now() + durDays * 86400000),
      };
      if (existing.planStage) userData.subscribedStage = existing.planStage;
      if (existing.planName) userData.planName = existing.planName;
      if (existing.period) userData.planPeriod = existing.period;
      if (user.referralDiscount > 0) {
        userData.referralDiscount = 0;
        userData.referralUsedAt = new Date();
      }
      await tx.user.update({ where: { id: existing.userId }, data: userData });
      await tx.payment.create({
        data: {
          userId: existing.userId,
          userName: existing.userName || user.name,
          transactionId: existing.transactionId || '',
          amount: Number(existing.price) || 0,
          method: existing.paymentMethod || 'vodafone-cash',
          planName: existing.planName || '',
          status: 'approved',
        }
      });
    }
  });
  await recordAuditLog({ actorId: actor, action: ACTIONS.SUBSCRIPTION_APPROVE, entity: 'SubRequest', entityId: id, metadata: { userId: existing.userId, planName: existing.planName }, ip: existing._ip, userAgent: existing._ua });
  return { ...existing, status: 'approved' };
}

async function rejectSubRequest(id, actor) {
  const existing = await subRequestRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  await subRequestRepo.update(id, { status: 'rejected', reviewedBy: actor, reviewedAt: new Date() });
  return { ...existing, status: 'rejected' };
}

async function deleteSubRequest(id, actor) {
  const existing = await subRequestRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  await subRequestRepo.softDelete(id, actor);
}

module.exports = { listSubRequests, getSubRequest, approveSubRequest, rejectSubRequest, deleteSubRequest };
