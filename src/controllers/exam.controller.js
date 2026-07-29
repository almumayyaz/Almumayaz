const { examService } = require('../services');

function actorId(req) {
  return req.user?.id || req.session?.user?.id;
}

async function start(req, res) {
  const uid = actorId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  const result = await examService.start(uid, req.body);
  if (result.notAllowed) return res.json({ success: false, error: result.reason, code: 'AVAILABILITY' });
  res.json({ success: true, attempt: result.attempt, serverTime: result.serverTime });
}

async function sync(req, res) {
  const uid = actorId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  const result = await examService.sync(uid, req.body);
  if (result.notFound) return res.json({ success: false, error: 'المحاولة غير موجودة' });
  res.json({ success: true, serverTime: result.serverTime, remaining: result.remaining, status: result.status, realEndTime: result.realEndTime });
}

async function saveAnswers(req, res) {
  const uid = actorId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  const result = await examService.saveAnswers(uid, req.body);
  if (result.notFound) return res.json({ success: false, error: 'المحاولة غير موجودة' });
  if (result.alreadySubmitted) return res.json({ success: false, error: 'تم تسليم الامتحان مسبقاً' });
  res.json({ success: true });
}

async function submit(req, res) {
  const uid = actorId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  const result = await examService.submit(uid, req.body);
  if (result.notFound) return res.json({ success: false, error: 'المحاولة غير موجودة' });
  if (result.alreadySubmitted) return res.json({ success: false, error: 'تم تسليم الامتحان مسبقاً' });
  res.json({ success: true, status: result.status, submittedAt: result.submittedAt });
}

async function grade(req, res) {
  const uid = actorId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  const result = await examService.grade(uid, req.body);
  if (result.notFound) return res.json({ success: false, error: 'المحاولة غير موجودة' });
  res.json({ success: true });
}

module.exports = { start, sync, saveAnswers, submit, grade };
