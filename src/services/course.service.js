const { recordAuditLog, ACTIONS } = require('../utils/auditLog');
const { courseRepo } = require('../repositories');

async function listCourses({ stage, grade, active } = {}) {
  const where = {};
  if (stage) where.stage = stage;
  if (grade) where.grade = grade;
  if (active !== undefined) where.active = active === 'true';
  return courseRepo.query(where, { orderBy: { order: 'asc' } });
}

async function getCourse(id) {
  const course = await courseRepo.get(id);
  if (!course || course.deletedAt) return null;
  return course;
}

async function createCourse(data, actor) {
  const course = await courseRepo.create({
    title: data.title || 'مادة جديدة',
    subtitle: data.subtitle || '',
    description: data.description || '',
    icon: data.icon || 'fa-book',
    color: data.color || '#A07200',
    gradient: data.gradient || 'linear-gradient(135deg, #A07200 0%, #D4A017 50%, #F6C453 100%)',
    stage: data.stage || 'all',
    grade: data.grade || '',
    semester: data.semester || 'all',
    sections: [],
  });
  await recordAuditLog({ actorId: actor, action: ACTIONS.COURSE_CREATE, entity: 'Course', entityId: course.id, ip: data._ip, userAgent: data._ua });
  return course;
}

async function updateCourse(id, body, actor) {
  const existing = await courseRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  const allowed = ['title', 'subtitle', 'description', 'icon', 'color', 'gradient', 'image', 'grade', 'stage', 'price', 'guestVisible', 'active', 'order', 'semester', 'sections', 'quiz'];
  const data = {};
  for (const field of allowed) {
    if (body[field] !== undefined) data[field] = body[field];
  }
  const updated = await courseRepo.update(id, data);
  await recordAuditLog({ actorId: actor, action: ACTIONS.COURSE_UPDATE, entity: 'Course', entityId: updated.id, ip: body._ip, userAgent: body._ua });
  return updated;
}

async function deleteCourse(id, actor) {
  const existing = await courseRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  await courseRepo.softDelete(id, actor);
}

async function createSection(courseId, { name }) {
  const existing = await courseRepo.get(courseId);
  if (!existing || existing.deletedAt) return null;
  const sections = Array.isArray(existing.sections) ? [...existing.sections] : [];
  const section = { id: 'sec-' + Date.now(), name: name || 'فرع جديد', lessons: [] };
  sections.push(section);
  await courseRepo.update(courseId, { sections });
  return section;
}

async function updateSection(courseId, sectionId, body) {
  const existing = await courseRepo.get(courseId);
  if (!existing || existing.deletedAt) return null;
  const sections = Array.isArray(existing.sections) ? [...existing.sections] : [];
  const idx = sections.findIndex(s => s.id === sectionId);
  if (idx === -1) return { sectionNotFound: true };
  sections[idx] = { ...sections[idx], ...body, id: sections[idx].id };
  await courseRepo.update(courseId, { sections });
  return sections[idx];
}

async function deleteSection(courseId, sectionId) {
  const existing = await courseRepo.get(courseId);
  if (!existing || existing.deletedAt) return null;
  const sections = Array.isArray(existing.sections) ? existing.sections.filter(s => s.id !== sectionId) : [];
  await courseRepo.update(courseId, { sections });
}

async function setCourseQuiz(courseId, body) {
  const existing = await courseRepo.get(courseId);
  if (!existing || existing.deletedAt) return null;
  const { title, questions, timerMinutes, timeSettings } = body;
  const quiz = {
    id: existing.quiz?.id || 'q' + Date.now(),
    title: title || (existing.quiz?.title || 'اختبار شامل'),
    questions: questions || [],
    timerMinutes: timerMinutes ?? existing.quiz?.timerMinutes ?? null,
    timeSettings: timeSettings ?? existing.quiz?.timeSettings ?? null,
  };
  await courseRepo.update(courseId, { quiz });
  return quiz;
}

async function deleteCourseQuiz(courseId) {
  const existing = await courseRepo.get(courseId);
  if (!existing || existing.deletedAt) return null;
  await courseRepo.update(courseId, { quiz: null });
}

module.exports = { listCourses, getCourse, createCourse, updateCourse, deleteCourse, createSection, updateSection, deleteSection, setCourseQuiz, deleteCourseQuiz };
