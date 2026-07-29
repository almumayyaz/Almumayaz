const { noteRepo } = require('../repositories');

async function listNotes({ stage, grade, courseId } = {}) {
  const where = {};
  if (stage) where.stage = stage;
  if (grade) where.grade = grade;
  if (courseId) where.courseId = courseId;
  return noteRepo.query(where, { orderBy: { createdAt: 'desc' } });
}

async function getNote(id) {
  const note = await noteRepo.get(id);
  if (!note || note.deletedAt) return null;
  return note;
}

async function createNote(data) {
  return noteRepo.create({
    title: data.title || 'مذكرة جديدة',
    description: data.description || '',
    fileUrl: data.fileUrl || '',
    filePath: data.filePath || '',
    stage: data.stage || '',
    grade: data.grade || '',
  });
}

async function updateNote(id, body) {
  const existing = await noteRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  const allowed = ['title', 'description', 'fileUrl', 'filePath', 'stage', 'grade'];
  const data = {};
  for (const field of allowed) {
    if (body[field] !== undefined) data[field] = body[field];
  }
  return noteRepo.update(id, data);
}

async function deleteNote(id, actor) {
  const existing = await noteRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  await noteRepo.softDelete(id, actor);
}

module.exports = { listNotes, getNote, createNote, updateNote, deleteNote };
