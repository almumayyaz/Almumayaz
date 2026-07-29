const { Firestore, FieldValue, FieldPath, getFirestore } = require('firebase-admin/firestore');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const admin = require('firebase-admin');
const log = require('./logger');
const { cacheGet, cacheSet, cacheInvalidate } = require('./cache');

let firestore = null;
const BATCH_LIMIT = 500;

function stripBOM(s) { return s && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

function initFirestore() {
  if (firestore) return firestore;
  try {
    if (!getApps().length) {
      const saRaw = stripBOM(process.env.FIREBASE_SERVICE_ACCOUNT || '');
      const dbUrl = stripBOM(process.env.FIREBASE_DATABASE_URL || '');
      let sa = null;
      if (saRaw) {
        let raw = saRaw.trim();
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        try { sa = JSON.parse(raw); } catch (e1) {
          try { sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch (e2) {}
        }
      }
      if (!sa) {
        try { sa = require('../../service-account.json'); } catch (e) {}
      }
      if (sa) {
        initializeApp({ credential: cert(sa), databaseURL: dbUrl });
      } else {
        initializeApp();
      }
    }
    firestore = getFirestore();
    log.info('Init', 'Firestore initialized');
    return firestore;
  } catch (e) {
    log.error('Init', 'Firestore init failed', e.message);
    return null;
  }
}

function getDb() {
  if (!firestore) return initFirestore();
  return firestore;
}

function parsePath(path) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { collection: null, docId: null, subPath: [] };
  if (parts.length === 1) return { collection: parts[0], docId: null, subPath: [] };
  return { collection: parts[0], docId: parts[1], subPath: parts.slice(2) };
}

function idField(item) {
  return item && (item.id || item.uid);
}

function docIdFor(item, index) {
  return idField(item) || String(index);
}

async function readCollection(collectionName) {
  try {
    const cached = cacheGet(collectionName);
    if (cached !== undefined) return JSON.parse(JSON.stringify(cached));
    const db = getDb();
    if (!db) {
      log.warn('readCollection', 'Firestore not available, using RTDB fallback');
      return null;
    }
    const snap = await db.collection(collectionName).get();
    const docs = [];
    snap.forEach(doc => {
      const data = doc.data();
      data._docId = doc.id;
      docs.push(data);
    });
    docs.sort((a, b) => {
      const ai = parseInt(a._docId);
      const bi = parseInt(b._docId);
      if (!isNaN(ai) && !isNaN(bi)) return ai - bi;
      return String(a._docId || '').localeCompare(String(b._docId || ''));
    });
    const clean = docs.map(d => { const { _docId, ...rest } = d; return rest; });
    log.info('readCollection', collectionName, { count: clean.length });
    cacheSet(collectionName, clean);
    return clean;
  } catch (e) {
    log.error('readCollection', collectionName, e.message);
    return null;
  }
}

async function writeCollection(collectionName, array) {
  try {
    const db = getDb();
    if (!db) {
      log.warn('writeCollection', 'Firestore not available');
      return;
    }
    if (!Array.isArray(array)) {
      log.error('writeCollection', 'Data must be an array', typeof array);
      return;
    }
    const colRef = db.collection(collectionName);
    const existing = await colRef.get();
    const existingIds = new Set();
    existing.forEach(d => existingIds.add(d.id));
    let batch = db.batch();
    let opCount = 0;
    let batchCount = 0;
    function commitBatch() {
      if (opCount > 0) {
        batchCount++;
        return batch.commit();
      }
    }
    array.forEach((item, idx) => {
      const id = docIdFor(item, idx);
      const ref = colRef.doc(id);
      const data = { ...item };
      delete data._docId;
      batch.set(ref, data);
      existingIds.delete(id);
      opCount++;
      if (opCount >= BATCH_LIMIT) {
        batch.commit();
        batch = db.batch();
        opCount = 0;
      }
    });
    existingIds.forEach(id => {
      const ref = colRef.doc(id);
      batch.delete(ref);
      opCount++;
    });
    await commitBatch();
    cacheInvalidate(collectionName);
    log.info('writeCollection', collectionName, { items: array.length, deleted: existingIds.size });
  } catch (e) {
    log.error('writeCollection', collectionName, e.message);
  }
}

async function getDocument(path) {
  try {
    const { collection, docId, subPath } = parsePath(path);
    if (!collection || !docId) {
      log.error('getDocument', 'Invalid path', path);
      return null;
    }
    const db = getDb();
    if (!db) return null;
    let ref = db.collection(collection).doc(docId);
    for (let i = 0; i < subPath.length; i += 2) {
      const subCol = subPath[i];
      const subDoc = subPath[i + 1];
      if (!subDoc) {
        log.error('getDocument', 'Incomplete subpath', path);
        return null;
      }
      ref = ref.collection(subCol).doc(subDoc);
    }
    const snap = await ref.get();
    if (!snap.exists) {
      log.debug('getDocument', 'Not found', path);
      return null;
    }
    return { id: snap.id, ...snap.data() };
  } catch (e) {
    log.error('getDocument', path, e.message);
    return null;
  }
}

async function setDocument(path, data) {
  try {
    const { collection, docId, subPath } = parsePath(path);
    if (!collection || !docId) {
      log.error('setDocument', 'Invalid path', path);
      return;
    }
    const db = getDb();
    if (!db) return;
    let ref = db.collection(collection).doc(docId);
    for (let i = 0; i < subPath.length; i += 2) {
      const subCol = subPath[i];
      const subDoc = subPath[i + 1];
      if (!subDoc) { log.error('setDocument', 'Incomplete subpath', path); return; }
      ref = ref.collection(subCol).doc(subDoc);
    }
    const clean = { ...data };
    delete clean._docId;
    await ref.set(clean);
    cacheInvalidate(collection);
    log.info('setDocument', path, { op: 'set' });
  } catch (e) {
    log.error('setDocument', path, e.message);
  }
}

async function updateDocument(path, data) {
  try {
    const { collection, docId, subPath } = parsePath(path);
    if (!collection || !docId) {
      log.error('updateDocument', 'Invalid path', path);
      return;
    }
    const db = getDb();
    if (!db) return;
    if (subPath.length > 0) {
      const fieldPath = subPath.join('.');
      const updateData = {};
      updateData[fieldPath] = data;
      const ref = db.collection(collection).doc(docId);
      await ref.update(updateData);
    } else {
      const ref = db.collection(collection).doc(docId);
      const clean = { ...data };
      delete clean._docId;
      await ref.update(clean);
    }
    cacheInvalidate(collection);
    log.info('updateDocument', path, { op: 'update' });
  } catch (e) {
    log.error('updateDocument', path, e.message);
  }
}

async function deleteDocument(path) {
  try {
    const { collection, docId, subPath } = parsePath(path);
    if (!collection || !docId) {
      log.error('deleteDocument', 'Invalid path', path);
      return false;
    }
    const db = getDb();
    if (!db) return false;
    let ref = db.collection(collection).doc(docId);
    for (let i = 0; i < subPath.length; i += 2) {
      ref = ref.collection(subPath[i]).doc(subPath[i + 1]);
    }
    await ref.delete();
    cacheInvalidate(collection);
    log.info('deleteDocument', path, { op: 'delete' });
    return true;
  } catch (e) {
    log.error('deleteDocument', path, e.message);
    return false;
  }
}

async function pushDocument(collectionName, data) {
  try {
    const db = getDb();
    if (!db) return null;
    const ref = await db.collection(collectionName).add(data);
    cacheInvalidate(collectionName);
    log.info('pushDocument', collectionName, { id: ref.id });
    return ref.id;
  } catch (e) {
    log.error('pushDocument', collectionName, e.message);
    return null;
  }
}

async function runTransaction(updateFn) {
  const db = getDb();
  if (!db) return null;
  try {
    const result = await db.runTransaction(updateFn);
    log.info('runTransaction', 'Transaction completed');
    return result;
  } catch (e) {
    log.error('runTransaction', 'Transaction failed', e.message);
    throw e;
  }
}

async function bulkDelete(collectionName, ids) {
  try {
    const db = getDb();
    if (!db) return;
    const batch = db.batch();
    const colRef = db.collection(collectionName);
    ids.forEach(id => batch.delete(colRef.doc(id)));
    await batch.commit();
    cacheInvalidate(collectionName);
    log.info('bulkDelete', collectionName, { count: ids.length });
  } catch (e) {
    log.error('bulkDelete', collectionName, e.message);
  }
}

async function deleteAllDocuments(collectionName) {
  try {
    const db = getDb();
    if (!db) return;
    const snap = await db.collection(collectionName).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    cacheInvalidate(collectionName);
    log.info('deleteAllDocuments', collectionName, { count: snap.size });
  } catch (e) {
    log.error('deleteAllDocuments', collectionName, e.message);
  }
}

async function getAllDocIds(collectionName) {
  try {
    const db = getDb();
    if (!db) return [];
    const snap = await db.collection(collectionName).select().get();
    return snap.docs.map(d => d.id);
  } catch (e) {
    log.error('getAllDocIds', collectionName, e.message);
    return [];
  }
}

async function queryCollection(collectionName, fieldPath, opStr, value) {
  try {
    const db = getDb();
    if (!db) return [];
    const snap = await db.collection(collectionName).where(fieldPath, opStr, value).get();
    const results = [];
    snap.forEach(doc => results.push({ _docId: doc.id, ...doc.data() }));
    log.info('queryCollection', collectionName, { field: fieldPath, op: opStr, count: results.length });
    return results.map(d => { const { _docId, ...rest } = d; return rest; });
  } catch (e) {
    log.error('queryCollection', collectionName, e.message);
    return [];
  }
}

module.exports = {
  initFirestore,
  getDb,
  FieldValue,
  FieldPath,
  readCollection,
  writeCollection,
  getDocument,
  setDocument,
  updateDocument,
  deleteDocument,
  pushDocument,
  runTransaction,
  bulkDelete,
  deleteAllDocuments,
  getAllDocIds,
  queryCollection,
};
