const { readCollection, writeCollection, getDocument, setDocument, updateDocument, deleteDocument } = require('./firestore');
const COLLECTION = 'subscriptions';

async function findAll() { return readCollection(COLLECTION); }
async function findById(id) { return getDocument(`${COLLECTION}/${id}`); }
async function create(id, data) { data.createdAt = data.createdAt || new Date().toISOString(); return setDocument(`${COLLECTION}/${id}`, data); }
async function update(id, data) { return updateDocument(`${COLLECTION}/${id}`, data); }
async function remove(id) { return deleteDocument(`${COLLECTION}/${id}`); }
async function writeAll(array) { return writeCollection(COLLECTION, array); }

module.exports = { findAll, findById, create, update, remove, writeAll, COLLECTION };
