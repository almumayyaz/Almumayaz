const crypto = require('crypto');
const { parentInviteRepo, userRepo } = require('../repositories');
const { getPrisma } = require('../database');

async function sendInvite(uid, { parentName, parentPhone, parentEmail }) {
  if (!parentName || !parentPhone) return { validationError: true };

  const existing = await parentInviteRepo.findFirst({ studentId: uid, status: 'pending' });
  if (existing) {
    await userRepo.update(uid, { parentName, parentPhone, parentEmail: parentEmail || '' });
    return { inviteLink: 'https://almumayaz.online/parent/invite/' + existing.token, parentEmail: existing.parentEmail, existing: true };
  }

  const token = 'PINVITE-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const prisma = getPrisma();
  const user = await userRepo.get(uid);

  const invite = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: uid }, data: { parentName, parentPhone, parentEmail: parentEmail || '' } });
    return tx.parentInvite.create({
      data: {
        studentId: uid,
        studentName: user?.name || '',
        studentStage: user?.stage || '',
        studentGrade: user?.grade || '',
        parentName,
        parentPhone,
        parentEmail: parentEmail || '',
        token,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }
    });
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

  const prisma = getPrisma();
  if (existingParent) {
    const existingChildren = typeof existingParent.childrenIds === 'string'
      ? JSON.parse(existingParent.childrenIds)
      : (Array.isArray(existingParent.childrenIds) ? existingParent.childrenIds : []);
    await prisma.$transaction(async (tx) => {
      if (!existingChildren.includes(invite.studentId)) {
        existingChildren.push(invite.studentId);
        await tx.user.update({ where: { id: existingParent.id }, data: { childrenIds: existingChildren } });
      }
      await tx.parentInvite.update({ where: { id: invite.id }, data: { status: 'accepted', acceptedAt: new Date(), parentUserId: existingParent.id } });
      await tx.user.update({ where: { id: invite.studentId }, data: { parentId: existingParent.id } });
    });
    return { message: 'تم ربط الطالب بحساب ولي الأمر الحالي' };
  }

  const argon2 = require('argon2');
  const passwordHash = await argon2.hash(password);
  let newParent;
  await prisma.$transaction(async (tx) => {
    newParent = await tx.user.create({
      data: {
        name: invite.parentName,
        email: (invite.parentEmail || 'parent-' + Date.now() + '@almumayaz.online'),
        passwordHash,
        phone: invite.parentPhone,
        role: 'parent',
        childrenIds: [invite.studentId],
        parentOf: [invite.studentName],
      }
    });
    await tx.user.update({ where: { id: invite.studentId }, data: { parentId: newParent.id } });
    await tx.parentInvite.update({ where: { id: invite.id }, data: { status: 'accepted', acceptedAt: new Date(), parentUserId: newParent.id } });
  });
  return {};
}

module.exports = { sendInvite, acceptInvite };
