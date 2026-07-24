const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const admin = require('firebase-admin');
// Firestore adapter — primary data store for all persistent collections
const fsCore = require('./services/firestore/firestore');
const log = require('./services/firestore/logger');

// Collections that have been migrated from RTDB to Firestore
const FIRESTORE_COLLECTIONS = new Set([
  'users', 'courses', 'settings', 'notifications', 'payments',
  'subscriptions', 'reviews', 'supportTickets', 'notes', 'quotes',
  'questionBanks', 'announcements', 'liveSessions', 'parentInvites',
  'chargeCodes', 'maintenanceMode', 'contacts', 'appConfig', 'cronLastRun',
  'themeConfig', 'subRequests', 'dismissed', 'studentAnalytics',
]);

// Feature flags for dual-write control (set via environment variables)
const USE_RTDB_FALLBACK = process.env.USE_RTDB_FALLBACK !== 'false';
const ENABLE_DUAL_WRITE = process.env.ENABLE_DUAL_WRITE !== 'false';

// Collections that stay on RTDB (real-time only)
const RTDB_REALTIME = new Set([
  'chats', '_usage', '_cronClaims', 'liveSessionAttendance',
]);

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
let _usage = null;
function trackUsage(op, sub) {
  if (!_usage) { try { _usage = require('./usage-tracker'); } catch(e) { return; } }
  _usage.trackFirebaseOp(op + '/' + sub);
}

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
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(normalizeSnapshot).filter(v => v != null);
  if (typeof val === 'object') {
    const keys2 = Object.keys(val);
    if (keys2.length > 0 && keys2.every(k => !isNaN(parseInt(k)))) {
      const sorted = keys2.slice().sort((a, b) => parseInt(a) - parseInt(b));
      if (sorted[0] === '0' && parseInt(sorted[sorted.length - 1]) === sorted.length - 1) {
        return sorted.map(k => normalizeSnapshot(val[k])).filter(v => v != null);
      }
    } else if (keys2.length > 0) {
      const first = val[keys2[0]];
      if (first && typeof first === 'object' && first.id) {
        return keys2.map(k => normalizeSnapshot(val[k])).filter(v => v != null);
      }
    }
    const obj = {};
    for (const k of keys2) obj[k] = normalizeSnapshot(val[k]);
    return obj;
  }
  return val;
}

async function readData(key, noCache) {
  // Read-through cache for cacheable top-level collections (stage 2/6/13/14).
  // A cache hit performs ZERO Firebase reads.
  if (!noCache && CACHEABLE.has(key)) {
    const cached = cacheGet(key);
    if (cached !== undefined) return clone(cached);
  }
  // For Firestore-migrated collections, read from Firestore (authoritative source)
  if (FIRESTORE_COLLECTIONS.has(key)) {
    try {
      perf.trackRead();
      log.info('readData', `Reading "${key}" from Firestore`);
      const val = await fsCore.readCollection(key);
      if (val !== null) {
        localStore.writeData(key, val).catch(function() {});
        if (!noCache && CACHEABLE.has(key) && !(Array.isArray(val) && val.length === 0)) cacheSet(key, val);
        return clone(val);
      }
      log.warn('readData', `Firestore returned null for "${key}"`);
    } catch (e) {
      log.error('readData', `Firestore error for "${key}"`, e.message);
    }
  }
  // Firestore-migrated collections: only fall back to RTDB if USE_RTDB_FALLBACK is enabled
  // Non-migrated collections: always read from RTDB
  const shouldReadFromRTDB = !FIRESTORE_COLLECTIONS.has(key) || USE_RTDB_FALLBACK;
  let val;
  let readFromFirebase = false;
  if (shouldReadFromRTDB && fbDb) {
    try {
      perf.trackRead();
      trackUsage('read', key);
      readFromFirebase = true;
      var snap = await Promise.race([
        fbDb.ref(key).once('value'),
        new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout')); }, 15000); })
      ]);
      val = normalizeSnapshot(snap.val());
    } catch (e) {
      console.error('Firebase read error, retrying:', e.message);
      // Retry once — Admin SDK connection may not be ready on cold start
      try {
        var snap2 = await Promise.race([
          fbDb.ref(key).once('value'),
          new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout')); }, 15000); })
        ]);
        val = normalizeSnapshot(snap2.val());
      } catch (e2) {
        console.error('Firebase read retry failed:', e2.message);
        val = undefined;
      }
    }
  }
  if (val === null || val === undefined) {
    if (!readFromFirebase) perf.trackRead();
    val = await localStore.readData(key);
  }
  // Persist successful Firebase reads to localStore for cold-start resilience
  if (val !== null && val !== undefined && readFromFirebase && !noCache) {
    localStore.writeData(key, val).catch(function() {});
  }
  if (val !== null && val !== undefined && !(Array.isArray(val) && val.length === 0) && !noCache && CACHEABLE.has(key)) cacheSet(key, val);
  return clone(val);
}

async function writeData(key, data) {
  // Write to local store first (always works)
  await localStore.writeData(key, data);
  // Dual-write to Firestore for migrated collections
  if (FIRESTORE_COLLECTIONS.has(key)) {
    try {
      log.info('writeData', `Writing "${key}" to Firestore`);
      await fsCore.writeCollection(key, data);
      log.info('writeData', `Firestore write OK for "${key}"`);
    } catch (e) {
      log.error('writeData', `Firestore write failed for "${key}"`, e.message);
    }
  }
  // Write to Firebase RTDB (controlled by feature flags)
  if (fbDb && (ENABLE_DUAL_WRITE || RTDB_REALTIME.has(key))) {
    try {
      perf.trackWrite();
      trackUsage('write', key);
      await fbDb.ref(key).set(data);
    } catch (e) {
      if (ENABLE_DUAL_WRITE) log.warn('writeData', 'RTDB write warning', e.message);
      else console.error('Firebase Admin write error:', e.message);
    }
  }
  // Always invalidate cache so next read fetches fresh data
  cacheInvalidate(key);
  return data;
}

// Stage 1/4: read a single user by id WITHOUT loading the whole `users` collection.
// Uses the (cached) users collection; falls back to a full read only when not found.
async function readUserById(id) {
  if (!id) return null;
  // Try direct Firestore document read first (avoids full collection scan)
  try {
    if (FIRESTORE_COLLECTIONS.has('users')) {
      const doc = await fsCore.getDocument('users/' + id);
      if (doc) return doc;
    }
  } catch (e) {
    log.warn('readUserById', 'Firestore direct read failed, falling back', e.message);
  }
  // Fallback: read full users collection and search
  const users = await readData('users');
  const list = Array.isArray(users) ? users : (users ? Object.values(users) : []);
  return list.find(u => u.id === id || u.uid === id) || null;
}

// Stage 4/5: shallow-merge `partial` into the node at `path` (keyed collections only,
// e.g. studentAnalytics/<uid>). On Firebase this is an atomic `update()`; locally it
// merges into the stored object. Much cheaper than rewriting the whole node.
async function updateData(path, partial) {
  perf.trackWrite();
  trackUsage('update', path.split('/')[0]);
  const collectionName = path.split('/')[0];
  // Write to Firestore for migrated collections
  if (FIRESTORE_COLLECTIONS.has(collectionName)) {
    try {
      await fsCore.updateDocument(path, partial);
      cacheInvalidate(collectionName);
    } catch (e) {
      log.error('updateData', `Firestore update failed for "${path}"`, e.message);
    }
  }
  // Write to Firebase RTDB (controlled by feature flags)
  const isRealtime = RTDB_REALTIME.has(collectionName);
  if (fbDb && (ENABLE_DUAL_WRITE || isRealtime)) {
    try {
      await fbDb.ref(path).update(partial);
      cacheInvalidate(collectionName);
      return partial;
    } catch (e) {
      if (ENABLE_DUAL_WRITE) log.warn('updateData', 'RTDB update warning', e.message);
      else console.error('Firebase Admin update error:', e.message);
    }
  }
  // Local fallback
  const leaf = await localStore.readData(path);
  const node = Object.assign((leaf == null) ? {} : clone(leaf), partial);
  await localStore.writeData(path, node);
  cacheInvalidate(collectionName);
  return partial;
}

// Stage 5: atomic read-modify-write transaction at `path`.
async function transactionData(path, mutate) {
  perf.trackWrite();
  trackUsage('transaction', path.split('/')[0]);
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
  const collectionName = path.split('/')[0];
  if (FIRESTORE_COLLECTIONS.has(collectionName)) {
    try {
      await fsCore.deleteAllDocuments(path);
      log.info('fbRemove', `Firestore delete for "${path}"`);
    } catch (e) {
      log.error('fbRemove', `Firestore delete failed for "${path}"`, e.message);
    }
  }
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
      try { require('./usage-tracker').track('fcm', 'sendFCM'); } catch (e) {}
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
        try { require('./usage-tracker').track('fcm', 'sendFCMToRole'); } catch (e) {}
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

module.exports = { db: fbDb, fbAuth, readData, writeData, updateData, transactionData, readUserById, pushData, fbRead, fbSet, fbPush, fbRemove, restGet, restPut, sendFCM, sendFCMToRole, admin, migrateSeedData, cacheInvalidate, fsCore, FIRESTORE_COLLECTIONS };

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
        // Also write to Firestore for migrated collections
        if (FIRESTORE_COLLECTIONS.has(key)) {
          try {
            await fsCore.writeCollection(key, seedData);
            log.info('migrateSeedData', `Wrote "${key}" to Firestore`);
          } catch (e) {
            log.error('migrateSeedData', `Firestore write failed for "${key}"`, e.message);
          }
        }
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
          if (FIRESTORE_COLLECTIONS.has(key)) {
            try {
              await fsCore.writeCollection(key, val);
              log.info('migrateSeedData', `Synced "${key}" to Firestore`);
            } catch (e) {
              log.error('migrateSeedData', `Firestore sync failed for "${key}"`, e.message);
            }
          }
        }
      }
    } catch (e) {
      console.error('migrateSeedData error for', key, e.message);
    }
  }
}
// Run migration on startup
migrateSeedData();
