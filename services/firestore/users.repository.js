const { readCollection, writeCollection, getDocument, setDocument, updateDocument, queryCollection, runTransaction, FieldValue } = require('./firestore');
const log = require('./logger');
const COLLECTION = 'users';

async function findAll() { return readCollection(COLLECTION); }

async function findById(uid) { return getDocument(`${COLLECTION}/${uid}`); }

async function create(uid, data) {
  data.createdAt = data.createdAt || new Date().toISOString();
  data.updatedAt = new Date().toISOString();
  await setDocument(`${COLLECTION}/${uid}`, data);
  return { id: uid, ...data };
}

async function update(uid, data) {
  data.updatedAt = new Date().toISOString();
  await updateDocument(`${COLLECTION}/${uid}`, data);
  return { id: uid, ...data };
}

async function remove(uid) { return deleteDocument(`${COLLECTION}/${uid}`); }

async function findByRole(role) { return queryCollection(COLLECTION, 'role', '==', role); }

async function findByEmail(email) {
  const results = await queryCollection(COLLECTION, 'email', '==', email);
  return results.length > 0 ? results[0] : null;
}

async function findByFcmToken(token) {
  const results = await queryCollection(COLLECTION, 'fcmToken', '==', token);
  return results.length > 0 ? results[0] : null;
}

async function updateProgress(uid, courseId, lessonId, data) {
  const fieldPath = `progress.${courseId}.lessons.${lessonId}`;
  const db = require('./firestore').getDb();
  if (!db) return;
  const ref = db.collection(COLLECTION).doc(uid);
  const updateData = {};
  updateData[fieldPath] = data;
  updateData.updatedAt = new Date().toISOString();
  try {
    await ref.update(updateData);
    log.info('users.updateProgress', uid, { courseId, lessonId });
  } catch (e) {
    log.error('users.updateProgress', uid, e.message);
  }
}

async function updateExamResults(uid, courseId, result) {
  const db = require('./firestore').getDb();
  if (!db) return;
  const ref = db.collection(COLLECTION).doc(uid);
  try {
    await ref.update({
      [`progress.${courseId}.examResults`]: FieldValue.arrayUnion(result),
      updatedAt: new Date().toISOString()
    });
  } catch (e) {
    log.error('users.updateExamResults', uid, e.message);
  }
}

module.exports = {
  findAll, findById, create, update, remove,
  findByRole, findByEmail, findByFcmToken,
  updateProgress, updateExamResults,
  COLLECTION,
};
