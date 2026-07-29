const { progressService } = require('../services');

function actorId(req) {
  return req.user?.id || req.session?.user?.id;
}

async function heartbeat(req, res) {
  const uid = actorId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  const { courseId, lessonId } = req.body;
  if (!courseId || !lessonId) return res.status(400).json({ error: 'courseId and lessonId are required' });
  const result = await progressService.heartbeat(uid, req.body);
  if (result.userNotFound) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true, progress: result });
}

async function markLessonComplete(req, res) {
  const uid = actorId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  const result = await progressService.markLessonComplete(uid, req.body);
  if (result.userNotFound) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true, progress: result });
}

async function getProgress(req, res) {
  const uid = actorId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  const progress = await progressService.getProgress(uid, req.params.courseId);
  if (progress.userNotFound) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true, progress });
}

async function summary(req, res) {
  const uid = actorId(req);
  if (!uid) return res.status(401).json({ error: 'Not authenticated' });
  const result = await progressService.summary(uid);
  res.json({ success: true, progress: result });
}

module.exports = { heartbeat, markLessonComplete, getProgress, summary };
