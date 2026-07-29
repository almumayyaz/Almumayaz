const { userService } = require('../services');
const { recordAuditLog, ACTIONS } = require('../utils/auditLog');

function actorId(req) {
  return req.user?.id || req.session?.user?.id;
}

async function list(req, res) {
  const users = await userService.listStudents(req.query);
  res.json(users);
}

async function getById(req, res) {
  const user = await userService.getStudent(req.params.id);
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json(user);
}

async function update(req, res) {
  const updated = await userService.updateStudent(req.params.id, req.body);
  if (updated.notFound) return res.status(404).json({ error: 'الطالب غير موجود' });
  res.json({ success: true, student: updated });
}

async function remove(req, res) {
  const result = await userService.deleteStudent(req.params.id, actorId(req));
  if (result && result.notFound) return res.status(404).json({ error: 'الطالب غير موجود' });
  await recordAuditLog({ actorId: actorId(req), action: ACTIONS.USER_DELETE, entity: 'User', entityId: req.params.id, ip: req.headers['x-forwarded-for'] || req.ip, userAgent: req.headers['user-agent'] });
  res.json({ success: true });
}

async function updateSubscription(req, res) {
  const updated = await userService.updateSubscription(req.params.id, req.body);
  if (updated.notFound) return res.status(404).json({ error: 'الطالب غير موجود' });
  if (updated.invalidAction) return res.status(400).json({ error: 'إجراء غير معروف' });
  await recordAuditLog({ actorId: actorId(req), action: ACTIONS.SUBSCRIPTION_APPROVE, entity: 'User', entityId: req.params.id, metadata: req.body, ip: req.headers['x-forwarded-for'] || req.ip, userAgent: req.headers['user-agent'] });
  res.json({ success: true, student: updated });
}

module.exports = { list, getById, update, remove, updateSubscription };
