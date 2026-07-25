const { readCollection, writeCollection, getDocument, setDocument, updateDocument, queryCollection, deleteDocument, getDb } = require('./firestore');
const log = require('./logger');
const COLLECTION = 'courses';

async function findAll() { return readCollection(COLLECTION); }

async function findById(id) { return getDocument(`${COLLECTION}/${id}`); }

async function create(id, data) {
  data.createdAt = data.createdAt || new Date().toISOString();
  data.updatedAt = new Date().toISOString();
  await setDocument(`${COLLECTION}/${id}`, data);
  return { id, ...data };
}

async function update(id, data) {
  data.updatedAt = new Date().toISOString();
  await updateDocument(`${COLLECTION}/${id}`, data);
  return { id, ...data };
}

async function remove(id) { return deleteDocument(`${COLLECTION}/${id}`); }

async function findByStage(stage) { return queryCollection(COLLECTION, 'stage', '==', stage); }

async function findByGrade(grade) { return queryCollection(COLLECTION, 'grade', '==', grade); }

async function findByStageAndGrade(stage, grade) {
  const db = getDb();
  if (!db) return [];
  try {
    const snap = await db.collection(COLLECTION)
      .where('stage', '==', stage)
      .where('grade', '==', grade)
      .get();
    const results = [];
    snap.forEach(doc => results.push(doc.data()));
    return results;
  } catch (e) {
    log.error('courses.findByStageAndGrade', '', e.message);
    return [];
  }
}

async function writeAll(array) { return writeCollection(COLLECTION, array); }

async function updateLessons(courseId, sectionId, lessons) {
  const db = getDb();
  if (!db) return;
  const ref = db.collection(COLLECTION).doc(courseId);
  try {
    const doc = await ref.get();
    if (!doc.exists) return;
    const data = doc.data();
    const sections = data.sections || [];
    const sectionIdx = sections.findIndex(s => s.id === sectionId);
    if (sectionIdx === -1) return;
    sections[sectionIdx].lessons = lessons;
    await ref.update({ sections, updatedAt: new Date().toISOString() });
  } catch (e) {
    log.error('courses.updateLessons', courseId, e.message);
  }
}

module.exports = {
  findAll, findById, create, update, remove,
  findByStage, findByGrade, findByStageAndGrade,
  writeAll, updateLessons,
  COLLECTION,
};
