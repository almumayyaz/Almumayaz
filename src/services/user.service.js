const { signAccessToken, createRefreshToken, rotateRefreshToken, revokeRefreshToken } = require('../utils/jwt');
const { recordAuditLog, ACTIONS } = require('../utils/auditLog');
const argon2 = require('argon2');
const { userRepo, refreshTokenRepo } = require('../repositories');

const SAFE_FIELDS = { id: true, name: true, email: true, phone: true, role: true, stage: true, grade: true, governorate: true, avatar: true, subscriptionStatus: true, subscriptionEnd: true, referralCode: true, parentName: true, parentPhone: true, parentEmail: true, fcmEnabled: true, phoneVerified: true };
const ALLOWED_UPDATE = ['name', 'phone', 'parentPhone', 'parentName', 'parentEmail', 'avatar', 'governorate'];

function pick(obj, keys) {
  const result = {};
  keys.forEach(k => { if (obj[k] !== undefined) result[k] = obj[k]; });
  return result;
}

async function register({ name, email, password, phone, stage, grade }) {
  const existing = await userRepo.findBy('email', email);
  if (existing) return { conflict: true };
  const passwordHash = await argon2.hash(password);
  const user = await userRepo.create({ name, email, passwordHash, phone: phone || '', stage: stage || '', grade: grade || '' });
  const accessToken = signAccessToken({ sub: user.id, role: user.role, email: user.email });
  const refreshToken = await createRefreshToken(user.id);
  return { user, accessToken, refreshToken };
}

async function login({ email, password }) {
  const user = await userRepo.findBy('email', email);
  if (!user || !user.passwordHash) return { unauthorized: true };
  const valid = await argon2.verify(user.passwordHash, password);
  if (!valid) return { unauthorized: true };
  const accessToken = signAccessToken({ sub: user.id, role: user.role, email: user.email });
  const refreshToken = await createRefreshToken(user.id);
  await userRepo.update(user.id, { lastLogin: new Date() });
  return { user, accessToken, refreshToken };
}

async function logout(refreshTokenCookie) {
  if (refreshTokenCookie) await revokeRefreshToken(refreshTokenCookie).catch(() => {});
}

async function refreshTokens(oldToken) {
  const { verifyRefreshToken } = require('../utils/jwt');
  let decoded;
  try { decoded = verifyRefreshToken(oldToken); } catch { return { unauthorized: true }; }
  const stored = await refreshTokenRepo.findBy('token', oldToken);
  if (!stored || stored.revoked || stored.expiresAt < new Date()) return { unauthorized: true, expired: true };
  const user = await userRepo.get(decoded.sub);
  if (!user) return { unauthorized: true };
  const newRefreshToken = await rotateRefreshToken(oldToken, user.id);
  const accessToken = signAccessToken({ sub: user.id, role: user.role, email: user.email });
  return { user, accessToken, refreshToken: newRefreshToken };
}

async function me(uid) {
  return userRepo.get(uid, { select: { id: true, name: true, email: true, role: true, phone: true, avatar: true, stage: true, grade: true } });
}

async function updateProfile(uid, body) {
  const user = await userRepo.get(uid);
  if (!user) return { notFound: true };
  const isSubscribed = user.subscriptionStatus === 'active' && (!user.subscriptionEnd || new Date(user.subscriptionEnd) > new Date());
  const allowed = pick(body, ALLOWED_UPDATE);
  if (!isSubscribed) {
    if (body.stage !== undefined) allowed.stage = body.stage;
    if (body.grade !== undefined) allowed.grade = body.grade;
  }
  allowed.lastLogin = new Date();
  const updated = await userRepo.update(uid, allowed, null, { select: SAFE_FIELDS });
  return updated;
}

async function submitPayment(uid, { transactionId, amount, paymentMethod: method, receiptImage }) {
  const { paymentRepo } = require('../repositories');
  return paymentRepo.create({
    userId: uid,
    transactionId: transactionId || '',
    amount: parseFloat(amount) || 0,
    method: method || 'manual',
    receiptImage: receiptImage || '',
    status: 'pending',
  });
}

// ── Admin student management ──

async function listStudents({ role, stage, grade, limit } = {}) {
  const where = {};
  if (role) where.role = role;
  if (stage) where.stage = stage;
  if (grade) where.grade = grade;
  return userRepo.query(where, { orderBy: { createdAt: 'desc' }, limit: limit ? parseInt(limit) : undefined });
}

async function getStudent(id) {
  const user = await userRepo.get(id);
  if (!user || user.deletedAt) return null;
  return user;
}

async function updateStudent(id, body) {
  const existing = await userRepo.get(id);
  if (!existing || existing.deletedAt) return { notFound: true };
  const allowed = ['name', 'email', 'phone', 'stage', 'grade', 'governorate', 'subscriptionStatus', 'subscriptionEnd', 'notes', 'active'];
  const data = {};
  for (const field of allowed) {
    if (body[field] !== undefined) data[field] = body[field];
  }
  return userRepo.update(id, data);
}

async function deleteStudent(id, actor) {
  const existing = await userRepo.get(id);
  if (!existing || existing.deletedAt) return { notFound: true };
  await userRepo.softDelete(id, actor);
}

async function updateSubscription(id, body) {
  const existing = await userRepo.get(id);
  if (!existing || existing.deletedAt) return { notFound: true };
  const { action, durationDays, stage, planName, period } = body;
  const data = {};
  switch (action) {
    case 'activate':
      data.subscriptionStatus = 'active';
      data.subscriptionStart = new Date().toISOString();
      data.subscriptionEnd = new Date(Date.now() + (durationDays || 30) * 86400000).toISOString();
      if (stage) data.subscribedStage = stage;
      if (planName) data.planName = planName;
      if (period) data.planPeriod = period;
      break;
    case 'deactivate':
      data.subscriptionStatus = 'inactive';
      data.planName = '';
      data.planPeriod = '';
      break;
    case 'extend':
      if (existing.subscriptionEnd) {
        const end = new Date(existing.subscriptionEnd);
        end.setDate(end.getDate() + (durationDays || 30));
        data.subscriptionEnd = end.toISOString();
      } else {
        data.subscriptionEnd = new Date(Date.now() + (durationDays || 30) * 86400000).toISOString();
      }
      data.subscriptionStatus = 'active';
      break;
    case 'cancel':
      data.subscriptionStatus = 'cancelled';
      break;
    case 'stop':
      data.subscriptionStatus = 'expired';
      data.subscriptionEnd = new Date().toISOString();
      break;
    default:
      return { invalidAction: true };
  }
  return userRepo.update(id, data);
}

module.exports = {
  register, login, logout, refreshTokens, me,
  updateProfile, submitPayment,
  listStudents, getStudent, updateStudent, deleteStudent, updateSubscription,
};
