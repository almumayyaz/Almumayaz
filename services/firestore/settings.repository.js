const { getDocument, setDocument, updateDocument, readCollection, cache } = require('./firestore');
const log = require('./logger');
const SINGLETON_ID = 'app_settings';

async function get() {
  const doc = await getDocument(`settings/${SINGLETON_ID}`);
  return doc || {};
}

async function set(data) {
  await setDocument(`settings/${SINGLETON_ID}`, data);
  cache.cacheInvalidate('settings');
  return data;
}

async function update(data) {
  await updateDocument(`settings/${SINGLETON_ID}`, data);
  cache.cacheInvalidate('settings');
  return data;
}

module.exports = { get, set, update };
