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
    const initOpts = { credential: cert(sa), databaseURL: dbUrl };
    const projectId = stripBOM(process.env.FIREBASE_PROJECT_ID || '') || sa.project_id || (dbUrl.match(/https:\/\/([^.]+)\.firebaseio\.com/) || [])[1] || '';
    if (projectId) initOpts.projectId = projectId;
    if (!getApps().length) {
      initializeApp(initOpts);
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

const fcmLog = require('./fcm-log');
const localStore = require('./data-store');
let useLocalFallback = !ready;
const perf = require('./perf');

/* ===================== READ-THROUGH CACHE (TTL) ===================== */
// Stage 2 / 6 / 13 / 14: in-memory cache with per-key TTL.
// Static collections are cached for 60s; `users` is cached for a SHORT 10s window
// (stage 1) so the per-request middleware no longer hits Firebase on every request,
// while auth/subscription changes stay fresh. Every write invalidates the key.
const STATIC_TTL_MS = 20000;
const USER_TTL_MS = 10000;
const CACHEABLE = new Set(['courses', 'notes', 'questionBanks', 'reviews', 'announcements', 'users', 'subRequests', 'maintenanceMode', 'themeConfig']);
const _cache = new Map(); // key -> { value, expires }

function cacheTtl(key) { return key === 'users' ? USER_TTL_MS : STATIC_TTL_MS; }
function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) { perf.trackCacheMiss(); return undefined; }
  if (Date.now() > e.expires) { _cache.delete(key); perf.trackCacheMiss(); return undefined; }
  perf.trackCacheHit();
  return e.value;
}
function cacheSet(key, val) {
  if (!CACHEABLE.has(key)) return;
  _cache.set(key, { value: val, expires: Date.now() + cacheTtl(key) });
}
function cacheInvalidate(key) { _cache.delete(key); }

function clone(o) {
  if (o === null || o === undefined) return o;
  try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; }
}

function normalizeSnapshot(val) {
  // Firebase returns stored arrays as objects with numeric keys - normalize to array
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const keys2 = Object.keys(val);
    if (keys2.length > 0) {
      if (keys2.every(k => !isNaN(parseInt(k)))) {
        return keys2.sort((a, b) => parseInt(a) - parseInt(b)).map(k => val[k]).filter(Boolean);
      } else {
        const first = val[keys2[0]];
        if (first && typeof first === 'object' && first.id) {
          return keys2.map(k => val[k]).filter(Boolean);
        }
      }
    }
  }
  if (Array.isArray(val)) return val.filter(Boolean);
  return val;
}

async function readData(key, noCache) {
  // Read-through cache for cacheable top-level collections (stage 2/6/13/14).
  // A cache hit performs ZERO Firebase reads.
  if (!noCache && CACHEABLE.has(key)) {
    const cached = cacheGet(key);
    if (cached !== undefined) return clone(cached);
  }
  let val;
  let readFromFirebase = false;
  // Try Firebase first (authoritative source - persists across instances)
  if (fbDb) {
    try {
      perf.trackRead();
      readFromFirebase = true;
      var snap = await Promise.race([
        fbDb.ref(key).once('value'),
        new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout')); }, 8000); })
      ]);
      val = normalizeSnapshot(snap.val());
    } catch (e) {
      console.error('Firebase read error, using local store:', e.message);
      val = undefined;
    }
  }
  if (val === null || val === undefined) {
    if (!readFromFirebase) perf.trackRead();
    val = await localStore.readData(key);
  }
  if (val !== null && val !== undefined && !noCache && CACHEABLE.has(key)) cacheSet(key, val);
  return clone(val);
}

async function writeData(key, data) {
  // Write to local store first (always works)
  await localStore.writeData(key, data);
  // Write to Firebase Admin SDK (persistent across instances)
  var firebaseOk = false;
  if (fbDb) {
    try {
      perf.trackWrite();
      await fbDb.ref(key).set(data);
      firebaseOk = true;
    } catch (e) {
      console.error('Firebase Admin write error:', e.message);
    }
  }
  // Always invalidate cache so next read fetches fresh data (from local store if Firebase failed)
  cacheInvalidate(key);
  return data;
}

// Stage 1/4: read a single user by id WITHOUT loading the whole `users` collection.
// Uses the (cached) users collection; falls back to a full read only when not found.
async function readUserById(id) {
  if (!id) return null;
  const users = await readData('users');
  const list = Array.isArray(users) ? users : (users ? Object.values(users) : []);
  return list.find(u => u.id === id || u.uid === id) || null;
}

// Stage 4/5: shallow-merge `partial` into the node at `path` (keyed collections only,
// e.g. studentAnalytics/<uid>). On Firebase this is an atomic `update()`; locally it
// merges into the stored object. Much cheaper than rewriting the whole node.
async function updateData(path, partial) {
  perf.trackWrite();
  if (fbDb) {
    try {
      await fbDb.ref(path).update(partial);
      cacheInvalidate(path.split('/')[0]);
      return partial;
    } catch (e) {
      console.error('Firebase Admin update error:', e.message);
    }
  }
  // Local fallback: the leaf document at `path` is stored as `<path>.json` by
  // writeData, so merge the partial into that same document and write it back.
  const leaf = await localStore.readData(path);
  const node = Object.assign((leaf == null) ? {} : clone(leaf), partial);
  await localStore.writeData(path, node);
  cacheInvalidate(path.split('/')[0]);
  return partial;
}

// Stage 5: atomic read-modify-write transaction at `path`.
async function transactionData(path, mutate) {
  perf.trackWrite();
  if (fbDb) {
    try {
      await fbDb.ref(path).transaction(current => mutate(current));
      cacheInvalidate(path.split('/')[0]);
      return;
    } catch (e) {
      console.error('Firebase Admin transaction error:', e.message);
    }
  }
  // Local fallback (single instance): read leaf document -> mutate -> write back.
  const leaf = await localStore.readData(path);
  const node = mutate(leaf == null ? null : clone(leaf));
  await localStore.writeData(path, node);
  cacheInvalidate(path.split('/')[0]);
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
    const user = await readUserById(userId);
    if (!user || !user.fcmToken) { console.log('sendFCM: no user or no fcmToken for', userId); return false; }
    if (!admin.messaging) { console.error('sendFCM: admin.messaging not available'); return false; }
        const message = {
          token: user.fcmToken,
          notification: { title: title, body: body },
          data: { url: url || '/', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
        };
    try {
      const response = await admin.messaging().send(message);
      fcmLog.add({ userId, title, messageId: response || 'unknown', success: true, error: null });
      return true;
    } catch (e) {
      console.error('sendFCM error:', e.code || e.message, 'for user', userId);
      fcmLog.add({ userId, title, messageId: null, success: false, error: e.code || e.message });
      if (e.code === 'messaging/invalid-registration-token' || e.code === 'messaging/registration-token-not-registered') {
        const users = await readData('users');
        const idx = users.findIndex(u => u.id === userId);
        if (idx !== -1) { users[idx].fcmToken = ''; await writeData('users', users); }
      }
      return false;
    }
  } catch (e) {
    console.error('sendFCM outer error:', e.message);
    return false;
  }
}

async function sendFCMToRole(role, title, body, url) {
  try {
    const users = await readData('users');
    const recipients = users.filter(u => u.role === role && u.fcmToken);
    console.log('sendFCMToRole: found', recipients.length, 'recipients for role', role);
    if (!admin.messaging) { console.error('sendFCMToRole: admin.messaging not available'); return 0; }
    const toClear = [];
    // Stage 10: send all notifications concurrently instead of serial await.
    await Promise.allSettled(recipients.map(async (u) => {
      try {
        const message = {
          token: u.fcmToken,
          notification: { title: title, body: body },
          data: { url: url || '/', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
        };
        const resp = await admin.messaging().send(message);
        fcmLog.add({ userId: u.id, title, messageId: resp || 'unknown', success: true, error: null });
      } catch (e) {
        console.error('sendFCMToRole error for', u.id, ':', e.code || e.message);
        fcmLog.add({ userId: u.id, title, messageId: null, success: false, error: e.code || e.message });
        if (e.code === 'messaging/invalid-registration-token' || e.code === 'messaging/registration-token-not-registered') {
          toClear.push(u.id);
        }
      }
    }));
    let sent = recipients.length - toClear.length;
    // Persist cleared tokens once, after all sends have settled.
    if (toClear.length) {
      const fresh = await readData('users');
      let changed = false;
      toClear.forEach(id => {
        const idx = fresh.findIndex(x => x.id === id);
        if (idx !== -1 && fresh[idx].fcmToken) { fresh[idx].fcmToken = ''; changed = true; }
      });
      if (changed) await writeData('users', fresh);
    }
    console.log('sendFCMToRole: sent', sent, 'out of', recipients.length);
    return sent;
  } catch (e) {
    console.error('sendFCMToRole outer error:', e.message);
    return 0;
  }
}

module.exports = { db: fbDb, fbAuth, readData, writeData, updateData, transactionData, readUserById, pushData, fbRead, fbSet, fbPush, fbRemove, restGet, restPut, sendFCM, sendFCMToRole, admin, migrateSeedData, cacheInvalidate };

// Startup: ensure seed data exists in Firebase
async function migrateSeedData() {
  if (!fbDb) return;
  const keys = ['courses', 'announcements', 'subscriptions', 'reviews', 'users', 'settings', 'quotes'];
  for (const key of keys) {
    try {
      const local = await localStore.readData(key);
      if (!local) continue;
      const seedData = Array.isArray(local) ? local : Object.values(local);
      if (!seedData.length) continue;

      const snap = await fbDb.ref(key).once('value');
      let val = snap.val();

      // Normalize existing Firebase data to array
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const k2 = Object.keys(val);
        if (k2.length > 0) {
          if (k2.every(k => !isNaN(parseInt(k)))) {
            val = k2.sort((a,b) => parseInt(a)-parseInt(b)).map(k => val[k]);
          } else {
            const first = val[k2[0]];
            if (first && typeof first === 'object' && first.id) {
              val = k2.map(k => val[k]);
            }
          }
        }
      }

      const isEmpty = !val || (Array.isArray(val) && val.length === 0) ||
        (typeof val === 'object' && !Array.isArray(val) && Object.keys(val || {}).length === 0);

      // If Firebase is empty, write all seed data
      if (isEmpty) {
        await fbDb.ref(key).set(Array.isArray(local) ? seedData : local);
        console.log('Migrated seed data to Firebase:', key, typeof local === 'object' && !Array.isArray(local) ? JSON.stringify(local).length : seedData.length);
        continue;
      }

      // For courses: merge missing lessons/sections/fields from seed
      if (key === 'courses' && Array.isArray(val) && Array.isArray(seedData)) {
        let changed = false;
        for (const c of val) {
          const sc = seedData.find(s => s.id === c.id);
          if (!sc) continue;
          ['lessons', 'sections', 'quiz', 'subtitle', 'description', 'icon', 'color', 'gradient', 'stage', 'grade', 'semester'].forEach(function(f) {
            if (f === 'quiz') {
              if ((!c.quiz || typeof c.quiz !== 'object' || Object.keys(c.quiz).length === 0) && sc.quiz) {
                c.quiz = JSON.parse(JSON.stringify(sc.quiz));
                changed = true;
              }
            } else if ((!c[f] || (Array.isArray(c[f]) && c[f].length === 0)) && sc[f]) {
              c[f] = JSON.parse(JSON.stringify(sc[f]));
              changed = true;
            }
          });
          // Force-update semester from seed data (teacher can override later)
          if (sc.semester && c.semester !== sc.semester) {
            c.semester = sc.semester;
            changed = true;
          }
        }
        if (changed) {
          await fbDb.ref(key).set(val);
          console.log('Merged seed data into Firebase courses');
        }
      }
    } catch (e) {
      console.error('migrateSeedData error for', key, e.message);
    }
  }
}
// Run migration on startup
migrateSeedData();
