const { getDocument, setDocument, updateDocument, getDb, FieldValue } = require('./firestore');
const log = require('./logger');
const COLLECTION = 'analytics';

async function trackEvent(service, action) {
  const db = getDb();
  if (!db) return;
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.collection(COLLECTION).doc('usage_stats');
  try {
    await ref.set({
      [`daily.${day}.${service}.${action}`]: FieldValue.increment(1),
      [`total.${service}`]: FieldValue.increment(1),
      lastUpdated: new Date().toISOString()
    }, { merge: true });
  } catch (e) {
    log.error('analytics.trackEvent', '', e.message);
  }
}

async function getStats() {
  return getDocument(`${COLLECTION}/usage_stats`);
}

async function resetStats() {
  const db = getDb();
  if (!db) return;
  try {
    await db.collection(COLLECTION).doc('usage_stats').set({});
  } catch (e) {
    log.error('analytics.resetStats', '', e.message);
  }
}

module.exports = { trackEvent, getStats, resetStats };
