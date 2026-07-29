const { recordAuditLog, ACTIONS } = require('../utils/auditLog');
const { lessonRepo, courseRepo } = require('../repositories');
const { getPrisma } = require('../database');

async function listLessons(courseId) {
  return lessonRepo.query({ courseId }, { orderBy: { order: 'asc' } });
}

async function getLesson(id) {
  const lesson = await lessonRepo.get(id);
  if (!lesson || lesson.deletedAt) return null;
  return lesson;
}

async function createLesson(courseId, data, actor) {
  const course = await courseRepo.get(courseId);
  if (!course || course.deletedAt) return { courseNotFound: true };
  const lesson = await lessonRepo.create({
    courseId,
    title: data.title || 'محاضرة جديدة',
    description: data.description || '',
    videos: data.videos || [],
    pdfFiles: data.pdfFiles || [],
    duration: data.duration || '00:00',
    order: data.order !== undefined ? data.order : 0,
    isFree: data.isFree || false,
    guestVisible: data.guestVisible || false,
    sectionId: data.sectionId || '',
    quiz: data.quiz || null,
  });
  await recordAuditLog({ actorId: actor, action: ACTIONS.LESSON_CREATE, entity: 'Lesson', entityId: lesson.id, metadata: { courseId, courseTitle: course.title }, ip: data._ip, userAgent: data._ua });
  return lesson;
}

async function updateLesson(id, body) {
  const existing = await lessonRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  const fields = ['title', 'description', 'videos', 'pdfFiles', 'duration', 'order', 'isFree', 'guestVisible', 'sectionId', 'quiz'];
  const data = {};
  for (const field of fields) {
    if (body[field] !== undefined) data[field] = body[field];
  }
  const updated = await lessonRepo.update(id, data);
  await recordAuditLog({ actorId: body._actor, action: ACTIONS.LESSON_UPDATE, entity: 'Lesson', entityId: updated.id, ip: body._ip, userAgent: body._ua });
  return updated;
}

async function deleteLesson(id, actor) {
  const existing = await lessonRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    await tx.lesson.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: actor || null } });
    if (existing.sectionId) {
      const course = await tx.course.findUnique({ where: { id: existing.courseId } });
      if (course && Array.isArray(course.sections)) {
        const sections = course.sections.map(s => {
          if (s.lessons) s.lessons = s.lessons.filter(lid => lid !== existing.id);
          return s;
        });
        await tx.course.update({ where: { id: existing.courseId }, data: { sections } });
      }
    }
  });
}

module.exports = { listLessons, getLesson, createLesson, updateLesson, deleteLesson };
