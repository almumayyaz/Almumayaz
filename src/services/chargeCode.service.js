const crypto = require('crypto');
const { chargeCodeRepo, userRepo } = require('../repositories');
const { getPrisma } = require('../database');

async function listChargeCodes() {
  return chargeCodeRepo.query({}, { orderBy: { createdAt: 'desc' } });
}

async function getChargeCode(id) {
  const code = await chargeCodeRepo.get(id);
  if (!code || code.deletedAt) return null;
  return code;
}

async function createChargeCode(data, actor) {
  const days = data.duration || data.expiryDays || 365;
  return chargeCodeRepo.create({
    code: data.code || 'CODE-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
    durationDays: days,
    maxUses: data.maxUses || 1,
    expiresAt: new Date(Date.now() + days * 86400000),
    createdBy: actor,
  });
}

async function updateChargeCode(id, body) {
  const existing = await chargeCodeRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  const allowed = ['durationDays', 'maxUses', 'expiresAt'];
  const data = {};
  for (const field of allowed) {
    if (body[field] !== undefined) data[field] = body[field];
  }
  return chargeCodeRepo.update(id, data);
}

async function deleteChargeCode(id, actor) {
  const existing = await chargeCodeRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  await chargeCodeRepo.softDelete(id, actor);
}

async function redeemChargeCode(uid, { code }) {
  const codeData = await chargeCodeRepo.findFirst({ code });
  if (!codeData) return { notFound: true };
  if (codeData.expiresAt && codeData.expiresAt < new Date()) return { expired: true };
  if (codeData.uses >= codeData.maxUses) return { maxUsesReached: true };
  const user = await userRepo.get(uid);
  if (!user) return { userNotFound: true };
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    await tx.chargeCode.update({ where: { id: codeData.id }, data: { uses: codeData.uses + 1 } });
    const durDays = codeData.durationDays || 30;
    const endDate = user.subscriptionEnd && new Date(user.subscriptionEnd) > new Date()
      ? new Date(new Date(user.subscriptionEnd).getTime() + durDays * 86400000)
      : new Date(Date.now() + durDays * 86400000);
    await tx.user.update({ where: { id: uid }, data: { subscriptionStatus: 'active', subscriptionStart: new Date(), subscriptionEnd: endDate } });
  });
  return {};
}

module.exports = { listChargeCodes, getChargeCode, createChargeCode, updateChargeCode, deleteChargeCode, redeemChargeCode };
