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

async function readData(key) {
  // Try Firebase first (authoritative source - persists across instances)
  if (fbDb) {
    try {
      const snap = await fbDb.ref(key).once('value');
      let val = snap.val();
      // Firebase returns stored arrays as objects with numeric keys - normalize to array
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const keys2 = Object.keys(val);
        if (keys2.length > 0 && keys2.every(k => !isNaN(parseInt(k)))) {
          val = keys2.sort((a,b) => parseInt(a)-parseInt(b)).map(k => val[k]);
        }
      }
      if (val !== null && val !== undefined) {
        localStore.writeData(key, val).catch(function(){});
        return val;
      }
    } catch (e) {
      console.error('Firebase read error, using local store:', e.message);
    }
  }
  // Fallback: read from local store (has seed data)
  const local = await localStore.readData(key);
  // If local has data and Firebase was empty/unavailable, migrate to Firebase
  if (fbDb && local && (Array.isArray(local) ? local.length > 0 : Object.keys(local).length > 0)) {
    fbDb.ref(key).set(local).catch(function(){});
  }
  return local;
}

async function writeData(key, data) {
  // Write to local store first (always works)
  await localStore.writeData(key, data);
  // Also write to Firebase Admin SDK (persistent across instances)
  if (fbDb) {
    try {
      await fbDb.ref(key).set(data);
    } catch (e) {
      console.error('Firebase Admin write error:', e.message);
    }
  }
  return data;
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
    return snap.val();
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

async function sendFCM(userId, title, body, url) {
  try {
    const users = await readData('users');
    const user = users.find(u => u.id === userId);
    if (!user || !user.fcmToken) { console.log('sendFCM: no user or no fcmToken for', userId); return false; }
    if (!admin.messaging) { console.error('sendFCM: admin.messaging not available'); return false; }
    const message = {
      token: user.fcmToken,
      data: { title: title, body: body, url: url || '/' }
    };
    await admin.messaging().send(message);
    console.log('sendFCM: sent to', userId, title);
    return true;
  } catch (e) {
    console.error('sendFCM error:', e.code || e.message, 'for user', userId);
    if (e.code === 'messaging/invalid-registration-token' || e.code === 'messaging/registration-token-not-registered') {
      const users = await readData('users');
      const idx = users.findIndex(u => u.id === userId);
      if (idx !== -1) { users[idx].fcmToken = ''; await writeData('users', users); }
    }
    return false;
  }
}

async function sendFCMToRole(role, title, body, url) {
  try {
    const users = await readData('users');
    const recipients = users.filter(u => u.role === role && u.fcmToken);
    console.log('sendFCMToRole: found', recipients.length, 'recipients for role', role);
    if (!admin.messaging) { console.error('sendFCMToRole: admin.messaging not available'); return 0; }
    let sent = 0;
    for (const u of recipients) {
      try {
        const message = {
          token: u.fcmToken,
          data: { title: title, body: body, url: url || '/' }
        };
        await admin.messaging().send(message);
        sent++;
      } catch (e) {
        console.error('sendFCMToRole: error for', u.id, e.code || e.message);
        if (e.code === 'messaging/invalid-registration-token' || e.code === 'messaging/registration-token-not-registered') {
          const idx = users.findIndex(x => x.id === u.id);
          if (idx !== -1) { users[idx].fcmToken = ''; }
        }
      }
    }
    if (recipients.some(u => !u.fcmToken)) await writeData('users', users);
    console.log('sendFCMToRole: sent', sent, 'out of', recipients.length);
    return sent;
  } catch (e) {
    console.error('sendFCMToRole outer error:', e.message);
    return 0;
  }
}

module.exports = { db: fbDb, fbAuth, readData, writeData, pushData, fbRead, fbSet, fbPush, fbRemove, restGet, restPut, sendFCM, sendFCMToRole, admin, migrateSeedData };

// Startup: migrate seed data to Firebase if missing
async function migrateSeedData() {
  if (!fbDb) return;
  const keys = ['courses', 'announcements', 'subscriptions', 'reviews', 'users'];
  for (const key of keys) {
    try {
      const snap = await fbDb.ref(key).once('value');
      let val = snap.val();
      // Firebase returns arrays as objects with numeric keys - normalize
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const keys2 = Object.keys(val);
        if (keys2.length > 0 && keys2.every(k => !isNaN(parseInt(k)))) {
          val = keys2.sort((a,b) => parseInt(a)-parseInt(b)).map(k => val[k]);
        }
      }
      if (val === null || val === undefined || (Array.isArray(val) && val.length === 0)) {
        const local = await localStore.readData(key);
        if (local && (Array.isArray(local) ? local.length > 0 : Object.keys(local).length > 0)) {
          await fbDb.ref(key).set(local);
          console.log('Migrated seed data to Firebase:', key);
        }
      } else if (key === 'courses' && Array.isArray(val)) {
        // Merge missing lessons/sections from seed
        const seed = await localStore.readData('courses');
        if (Array.isArray(seed)) {
          let changed = false;
          for (const c of val) {
            const sc = seed.find(s => s.id === c.id);
            if (!sc) continue;
            if ((!c.lessons || c.lessons.length === 0) && sc.lessons?.length) {
              c.lessons = sc.lessons; changed = true;
            }
            if ((!c.sections || c.sections.length === 0) && sc.sections?.length) {
              c.sections = sc.sections; changed = true;
            }
            if ((!c.quiz || Object.keys(c.quiz).length === 0) && sc.quiz) {
              c.quiz = sc.quiz; changed = true;
            }
          }
          if (changed) {
            await fbDb.ref(key).set(val);
            console.log('Merged missing lessons/sections into Firebase courses');
          }
        }
      }
    } catch (e) {
      console.error('migrateSeedData error for', key, e.message);
    }
  }
}
// Run migration on startup (fire-and-forget, resolves before first request)
migrateSeedData();
