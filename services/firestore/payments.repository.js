const { readCollection, writeCollection, getDocument, setDocument, updateDocument, deleteDocument, queryCollection } = require('./firestore');
const log = require('./logger');
const COLLECTION = 'payments';

async function findAll() { return readCollection(COLLECTION); }
async function findById(id) { return getDocument(`${COLLECTION}/${id}`); }
async function create(id, data) { data.createdAt = data.createdAt || new Date().toISOString(); return setDocument(`${COLLECTION}/${id}`, data); }
async function update(id, data) { return updateDocument(`${COLLECTION}/${id}`, data); }
async function remove(id) { return deleteDocument(`${COLLECTION}/${id}`); }
async function writeAll(array) { return writeCollection(COLLECTION, array); }
async function findByUserId(uid) { return queryCollection(COLLECTION, 'userId', '==', uid); }
async function findByStatus(status) { return queryCollection(COLLECTION, 'status', '==', status); }

module.exports = { findAll, findById, create, update, remove, writeAll, findByUserId, findByStatus, COLLECTION };
