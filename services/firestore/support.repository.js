const { readCollection, writeCollection, getDocument, setDocument, updateDocument, deleteDocument, queryCollection } = require('./firestore');
const COLLECTION = 'supportTickets';

async function findAll() { return readCollection(COLLECTION); }
async function findById(id) { return getDocument(`${COLLECTION}/${id}`); }
async function create(data) { data.createdAt = data.createdAt || new Date().toISOString(); return setDocument(`${COLLECTION}/${data.id}`, data); }
async function update(id, data) { return updateDocument(`${COLLECTION}/${id}`, data); }
async function remove(id) { return deleteDocument(`${COLLECTION}/${id}`); }
async function writeAll(array) { return writeCollection(COLLECTION, array); }
async function findByUserId(uid) { return queryCollection(COLLECTION, 'userId', '==', uid); }

module.exports = { findAll, findById, create, update, remove, writeAll, findByUserId, COLLECTION };
