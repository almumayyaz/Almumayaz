const crypto = require('crypto');
const { parentInviteRepo, userRepo } = require('../repositories');

async function sendInvite(uid, { parentName, parentPhone, parentEmail }) {
  if (!parentName || !parentPhone) return { validationError: true };

  const existing = await parentInviteRepo.findFirst({ studentId: uid, status: 'pending' });
  if (existing) {
    const user = await userRepo.get(uid);
    const inviteLink = 'https://almumayaz.online/parent/invite/' + existing.token;
    await userRepo.update(uid, { parentName, parentPhone, parentEmail: parentEmail || '' });
    return { inviteLink, parentEmail: existing.parentEmail, existing: true };
  }

  await userRepo.update(uid, { parentName, parentPhone, parentEmail: parentEmail || '' });
  const token = 'PINVITE-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const user = await userRepo.get(uid);

  const invite = await parentInviteRepo.create({
    studentId: uid,
    studentName: user?.name || '',
    studentStage: user?.stage || '',
    studentGrade: user?.grade || '',
    parentName,
    parentPhone,
    parentEmail: parentEmail || '',
    token,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  const inviteLink = 'https://almumayaz.online/parent/invite/' + token;

  if (parentEmail && parentEmail.includes('@')) {
    try {
      const emailService = require('../../services/email.service');
      const inviteHtml = emailService.inviteEmailHtml(parentName, user?.name || '', inviteLink);
      await emailService.sendMail(parentEmail, 'دعوة لمتابعة الطالب - منصة المُميز', inviteHtml);
    } catch (_) { /* email sending is optional */ }
  }

  return { inviteLink, invite: { ...invite, parentEmail }, invite };
}

async function acceptInvite({ token, password }) {
  if (!token || !password || password.length < 6) return { validationError: true };

  const invite = await parentInviteRepo.findBy('token', token);
  if (!invite || invite.status !== 'pending') return { notFound: true };

  const existingParent = await userRepo.findFirst({ role: 'parent', phone: invite.parentPhone });

  if (existingParent) {
    const existingChildren = typeof existingParent.childrenIds === 'string'
      ? JSON.parse(existingParent.childrenIds)
      : (Array.isArray(existingParent.childrenIds) ? existingParent.childrenIds : []);
    if (!existingChildren.includes(invite.studentId)) {
      existingChildren.push(invite.studentId);
      await userRepo.update(existingParent.id, { childrenIds: existingChildren });
    }
    await parentInviteRepo.update(invite.id, { status: 'accepted', acceptedAt: new Date(), parentUserId: existingParent.id });
    await userRepo.update(invite.studentId, { parentId: existingParent.id });
    return { message: 'تم ربط الطالب بحساب ولي الأمر الحالي' };
  }

  const argon2 = require('argon2');
  const passwordHash = await argon2.hash(password);
  const newParent = await userRepo.create({
    name: invite.parentName,
    email: (invite.parentEmail || 'parent-' + Date.now() + '@almumayaz.online'),
    passwordHash,
    phone: invite.parentPhone,
    role: 'parent',
    childrenIds: [invite.studentId],
    parentOf: [invite.studentName],
  });
  await userRepo.update(invite.studentId, { parentId: newParent.id });
  await parentInviteRepo.update(invite.id, { status: 'accepted', acceptedAt: new Date(), parentUserId: newParent.id });
  return {};
}

module.exports = { sendInvite, acceptInvite };
