const { lessonService } = require('../services');

function actorId(req) {
  return req.user?.id || req.session?.user?.id;
}

async function list(req, res) {
  const lessons = await lessonService.listLessons(req.params.courseId);
  res.json(lessons);
}

async function getById(req, res) {
  const lesson = await lessonService.getLesson(req.params.lessonId);
  if (!lesson) return res.status(404).json({ error: 'المحاضرة غير موجودة' });
  res.json(lesson);
}

async function create(req, res) {
  const result = await lessonService.createLesson(req.params.courseId, { ...req.body, _ip: req.headers['x-forwarded-for'] || req.ip, _ua: req.headers['user-agent'] }, actorId(req));
  if (result.courseNotFound) return res.status(404).json({ error: 'المادة غير موجودة' });
  res.status(201).json({ success: true, lesson: result });
}

async function update(req, res) {
  const updated = await lessonService.updateLesson(req.params.lessonId, { ...req.body, _actor: actorId(req), _ip: req.headers['x-forwarded-for'] || req.ip, _ua: req.headers['user-agent'] });
  if (!updated) return res.status(404).json({ error: 'المحاضرة غير موجودة' });
  res.json({ success: true, lesson: updated });
}

async function remove(req, res) {
  const result = await lessonService.deleteLesson(req.params.lessonId, actorId(req));
  if (result === null) return res.status(404).json({ error: 'المحاضرة غير موجودة' });
  res.json({ success: true });
}

module.exports = { list, getById, create, update, remove };
