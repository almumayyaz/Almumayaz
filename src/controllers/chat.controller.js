const { chatService } = require('../services');

function actorId(req) {
  return req.user?.id || req.session?.user?.id;
}

function actorName(req) {
  return req.user?.name || req.session?.user?.name || 'مستخدم';
}

async function getMessages(req, res) {
  const messages = await chatService.getMessages(actorId(req), req.params.studentId);
  res.json({ success: true, messages });
}

async function sendMessage(req, res) {
  const isAdmin = req.user?.role === 'admin' || req.session?.user?.role === 'admin';
  const result = await chatService.sendMessage(actorId(req), actorName(req), req.params.studentId || actorId(req), isAdmin, req.body);
  if (result.emptyMessage) return res.status(400).json({ error: 'لا يمكن إرسال رسالة فارغة' });
  res.json({ success: true, message: result });
}

async function markRead(req, res) {
  await chatService.markRead(actorId(req), req.params.studentId);
  res.json({ success: true });
}

async function deleteChat(req, res) {
  await chatService.deleteChat(req.params.studentId);
  res.json({ success: true });
}

async function listSessions(req, res) {
  const sessions = await chatService.listSessions();
  res.json(sessions);
}

module.exports = { getMessages, sendMessage, markRead, deleteChat, listSessions };
