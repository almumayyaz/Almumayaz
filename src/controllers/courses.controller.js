const { courseService } = require('../services');

function actorId(req) {
  return req.user?.id || req.session?.user?.id;
}

async function list(req, res) {
  const courses = await courseService.listCourses(req.query);
  res.json(courses);
}

async function getById(req, res) {
  const course = await courseService.getCourse(req.params.id);
  if (!course) return res.status(404).json({ error: 'المادة غير موجودة' });
  res.json(course);
}

async function create(req, res) {
  const course = await courseService.createCourse({ ...req.body, _ip: req.headers['x-forwarded-for'] || req.ip, _ua: req.headers['user-agent'] }, actorId(req));
  res.status(201).json({ success: true, course });
}

async function update(req, res) {
  const updated = await courseService.updateCourse(req.params.id, { ...req.body, _ip: req.headers['x-forwarded-for'] || req.ip, _ua: req.headers['user-agent'] }, actorId(req));
  if (!updated) return res.status(404).json({ error: 'المادة غير موجودة' });
  res.json({ success: true, course: updated });
}

async function remove(req, res) {
  const result = await courseService.deleteCourse(req.params.id, actorId(req));
  if (result === null) return res.status(404).json({ error: 'المادة غير موجودة' });
  res.json({ success: true });
}

async function createSection(req, res) {
  const section = await courseService.createSection(req.params.id, req.body);
  if (!section) return res.status(404).json({ error: 'المادة غير موجودة' });
  res.json({ success: true, section });
}

async function updateSection(req, res) {
  const result = await courseService.updateSection(req.params.id, req.params.sectionId, req.body);
  if (!result) return res.status(404).json({ error: 'المادة غير موجودة' });
  if (result.sectionNotFound) return res.status(404).json({ error: 'الفرع غير موجود' });
  res.json({ success: true, section: result });
}

async function deleteSection(req, res) {
  const result = await courseService.deleteSection(req.params.id, req.params.sectionId);
  if (result === null) return res.status(404).json({ error: 'المادة غير موجودة' });
  res.json({ success: true });
}

async function setQuiz(req, res) {
  const quiz = await courseService.setCourseQuiz(req.params.id, req.body);
  if (!quiz) return res.status(404).json({ error: 'المادة غير موجودة' });
  res.json({ success: true, quiz });
}

async function deleteQuiz(req, res) {
  const result = await courseService.deleteCourseQuiz(req.params.id);
  if (!result) return res.status(404).json({ error: 'المادة غير موجودة' });
  res.json({ success: true });
}

module.exports = { list, getById, create, update, remove, createSection, updateSection, deleteSection, setQuiz, deleteQuiz };
