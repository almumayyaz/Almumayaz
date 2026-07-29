const { chatSessionRepo, chatMessageRepo, userRepo } = require('../repositories');
const { getPrisma } = require('../database');

function chatId(uid) {
  if (!uid) return 'guest-' + Date.now();
  return 'student-' + uid;
}

async function getMessages(uid, studentId) {
  const sessionId = studentId ? 'student-' + studentId : chatId(uid);
  const messages = await chatMessageRepo.query({ sessionId }, { orderBy: { createdAt: 'asc' } });
  return messages;
}

async function sendMessage(uid, uname, rawStudentId, isAdmin, { text, image }) {
  if (!text && !image) return { emptyMessage: true };
  const realStudentId = rawStudentId || uid;
  const sessionId = 'student-' + (isAdmin && rawStudentId ? rawStudentId : uid);
  const senderName = isAdmin ? 'محمد عفيفي' : (uname || 'زائر');
  const senderRole = isAdmin ? 'admin' : 'student';
  const senderId = isAdmin ? uid : uid;

  let session = await chatSessionRepo.get(sessionId);
  if (!session) {
    session = await chatSessionRepo.create({ id: sessionId, studentId: realStudentId, studentName: uname || '', status: 'open' });
  }

  const msg = await chatMessageRepo.create({
    sessionId,
    senderId,
    senderName,
    senderRole,
    text: text || '',
    image: image || '',
  });

  if (isAdmin && rawStudentId) {
    const student = await userRepo.get(rawStudentId);
    if (student?.fcmToken) {
      const preview = text ? (text.length > 80 ? text.slice(0, 80) + '...' : text) : '📷 صورة';
      try {
        const { sendFCM } = require('../../prisma-bridge');
        await sendFCM(rawStudentId, 'رسالة جديدة من الأستاذ محمد عفيفي 📩', preview, '/student/chat');
      } catch (e) { /* ignore */ }
    }
  }

  if (!isAdmin) {
    const admins = await userRepo.query({ role: 'admin' });
    const preview = text ? (text.length > 80 ? text.slice(0, 80) + '...' : text) : '📷 صورة';
    for (const admin of admins) {
      if (admin.fcmToken) {
        try {
          const { sendFCM } = require('../../prisma-bridge');
          await sendFCM(admin.id, 'رسالة جديدة من ' + uname, preview, '/admin/chat/' + encodeURIComponent(realStudentId));
        } catch (e) { /* ignore */ }
      }
    }
  }

  return msg;
}

async function markRead(uid, studentId) {
  const sessionId = studentId ? 'student-' + studentId : chatId(uid);
  const targetSender = 'student';
  await chatMessageRepo.updateMany({ sessionId, senderRole: targetSender, read: false }, { read: true });
}

async function deleteChat(studentId) {
  const sessionId = 'student-' + studentId;
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    await tx.chatMessage.deleteMany({ where: { sessionId } });
    await tx.chatSession.deleteMany({ where: { id: sessionId } });
  });
}

async function listSessions() {
  const sessions = await chatSessionRepo.list({
    orderBy: { updatedAt: 'desc' },
    include: {
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    }
  });
  return sessions.map(s => {
    const lastMsg = s.messages[0];
    return {
      id: s.id,
      studentId: s.studentId,
      studentName: s.studentName,
      status: s.status,
      lastMessage: lastMsg ? { text: lastMsg.text, createdAt: lastMsg.createdAt } : null,
      unreadCount: 0,
      createdAt: s.createdAt,
    };
  });
}

module.exports = { getMessages, sendMessage, markRead, deleteChat, listSessions };
