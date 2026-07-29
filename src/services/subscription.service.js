const { recordAuditLog, ACTIONS } = require('../utils/auditLog');
const { subscriptionRepo } = require('../repositories');

async function listSubscriptions() {
  return subscriptionRepo.query({}, { orderBy: { createdAt: 'desc' } });
}

async function createSubscription(data, actor) {
  const sub = await subscriptionRepo.create({
    name: data.name || 'باقة جديدة',
    price: String(data.price || '0'),
    currency: data.currency || 'جنيه',
    period: data.period || 'شهرياً',
    features: data.features || [],
    popular: data.popular || false,
    stage: data.stage || '',
    durationDays: parseInt(data.durationDays) || 30,
    allowedBranches: data.allowedBranches || undefined,
  });
  await recordAuditLog({ actorId: actor, action: ACTIONS.SUBSCRIPTION_CREATE, entity: 'Subscription', entityId: sub.id, ip: data._ip, userAgent: data._ua });
  return sub;
}

async function updateSubscription(id, body, actor) {
  const existing = await subscriptionRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  const allowed = ['name', 'price', 'currency', 'period', 'features', 'popular', 'stage', 'durationDays', 'allowedBranches'];
  const data = {};
  for (const field of allowed) {
    if (body[field] !== undefined) data[field] = body[field];
  }
  if (data.features && !Array.isArray(data.features)) data.features = [];
  if (data.price !== undefined) data.price = String(data.price);
  const updated = await subscriptionRepo.update(id, data);
  await recordAuditLog({ actorId: actor, action: ACTIONS.SUBSCRIPTION_APPROVE, entity: 'Subscription', entityId: updated.id, ip: body._ip, userAgent: body._ua });
  return updated;
}

async function deleteSubscription(id, actor) {
  const existing = await subscriptionRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  await subscriptionRepo.softDelete(id, actor);
}

module.exports = { listSubscriptions, createSubscription, updateSubscription, deleteSubscription };
