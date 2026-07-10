const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const admin = require('firebase-admin');

function stripBOM(s) { return s && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

const saRaw = stripBOM(process.env.FIREBASE_SERVICE_ACCOUNT || '');
const dbUrl = stripBOM(process.env.FIREBASE_DATABASE_URL || '');
const baseUrl = dbUrl.replace(/\/+$/, '');

function loadServiceAccount() {
  if (saRaw) {
    let raw = saRaw.trim();
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    try { return JSON.parse(raw); } catch (e1) {
      try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch (e2) {
        console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT:', e2.message);
        return null;
      }
    }
  }
  try {
    return require('./service-account.json');
  } catch (e) {
    return null;
  }
}

let fbAuth = null;
let fbDb = null;
let ready = false;

try {
  const sa = loadServiceAccount();
  if (sa && dbUrl) {
    if (!getApps().length) {
      initializeApp({ credential: cert(sa), databaseURL: dbUrl });
    }
    fbAuth = getAuth();
    fbDb = admin.database();
    ready = true;
  }
} catch (e) {
  console.error('Firebase auth init error:', e.message);
}

function restGet(path) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const url = new URL(baseUrl + '/' + path + '.json');
    https.get(url.toString(), (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(data));
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

function restPut(path, data) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const url = new URL(baseUrl + '/' + path + '.json');
    const body = JSON.stringify(data);
    const req = https.request(url.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(d));
        resolve(JSON.parse(d));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function restPost(path, data) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const url = new URL(baseUrl + '/' + path + '.json');
    const body = JSON.stringify(data);
    const req = https.request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(d));
        resolve(JSON.parse(d));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const localStore = require('./data-store');
let useLocalFallback = !ready;

function toArray(val) {
  if (Array.isArray(val)) return val.map(toArray);
  if (val && typeof val === 'object') {
    const keys = Object.keys(val).filter(k => /^\d+$/.test(k)).sort((a, b) => parseInt(a) - parseInt(b));
    if (keys.length === Object.keys(val).length) return keys.map(k => toArray(val[k]));
    const obj = {};
    for (const k of Object.keys(val)) obj[k] = toArray(val[k]);
    return obj;
  }
  return val;
}

async function readData(key) {
  if (useLocalFallback) return localStore.readData(key);
  try {
    const val = await restGet(key);
    if (val === null || val === undefined) return key.endsWith('s') ? [] : {};
    return key.endsWith('s') ? toArray(val) : val;
  } catch (e) {
    console.error('Firebase read error, falling back to local:', e.message);
    return localStore.readData(key);
  }
}

async function writeData(key, data) {
  if (useLocalFallback) return localStore.writeData(key, data);
  try {
    await restPut(key, data);
  } catch (e) {
    console.error('Firebase write error, falling back to local:', e.message);
    return localStore.writeData(key, data);
  }
}

async function pushData(key, item) {
  if (useLocalFallback && localStore.pushData) return localStore.pushData(key, item);
  try {
    const result = await restPost(key, item);
    return result.name;
  } catch (e) {
    console.error('Firebase push error, falling back:', e.message);
    if (localStore.pushData) return localStore.pushData(key, item);
  }
}

async function fbRead(path) {
  if (!fbDb) return readData(path);
  try {
    const snap = await fbDb.ref(path).once('value');
    const val = snap.val();
    if (val === null || val === undefined) return path.endsWith('s') ? [] : {};
    return path.endsWith('s') ? toArray(val) : val;
  } catch (e) {
    console.error('Firebase Admin read error:', e.message);
    return readData(path);
  }
}

async function fbSet(path, data) {
  if (!fbDb) return writeData(path, data);
  try {
    await fbDb.ref(path).set(data);
    return data;
  } catch (e) {
    console.error('Firebase Admin write error:', e.message);
    return writeData(path, data);
  }
}

async function fbPush(path, data) {
  if (!fbDb) return pushData(path, data);
  try {
    const ref = await fbDb.ref(path).push(data);
    return ref.key;
  } catch (e) {
    console.error('Firebase Admin push error:', e.message);
    return pushData(path, data);
  }
}

async function fbRemove(path) {
  if (!fbDb) throw new Error('Firebase not available');
  try {
    await fbDb.ref(path).remove();
    return true;
  } catch (e) {
    console.error('Firebase Admin remove error:', e.message);
    throw e;
  }
}

module.exports = { db: fbDb, fbAuth, readData, writeData, pushData, fbRead, fbSet, fbPush, fbRemove, restGet, restPut };
