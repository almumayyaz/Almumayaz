const admin = require('firebase-admin');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

let _firestore = null;

function getFirestore() {
  if (_firestore) return _firestore;
  try {
    const apps = admin.apps;
    if (!apps.length) {
      const app = require('../firebase-admin');
      _firestore = admin.firestore();
    } else {
      _firestore = admin.firestore();
    }
    return _firestore;
  } catch (e) {
    console.error('src/db Firestore init error:', e.message);
    throw e;
  }
}

module.exports = { getFirestore, FieldValue, Timestamp, admin };
