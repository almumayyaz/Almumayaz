/**
 * prisma-bridge.js
 * ================
 * Prisma-based compatibility layer that replaces Firebase readData/writeData
 * calls transparently, without modifying app.js.
 *
 * Collection-to-model mapping:
 *   users           → user            subscriptions  → subscription
 *   courses         → course          reviews        → review
 *   payments        → payment         supportTickets → supportTicket
 *   notes           → note            quotes         → quote
 *   questionBanks   → questionBank    announcements  → announcement
 *   liveSessions    → liveSession     parentInvites  → parentInvite
 *   chargeCodes     → chargeCode      subRequests    → subRequest
 *   dismisseds      → dismissed       studentAnalytics → studentAnalytic
 *   notifications   → notification    scheduledNotifications → scheduledNotification
 *   examAttempts    → examAttempt     enrollments    → enrollment
 *   lessons         → lesson          units          → unit
 *   videos          → video           lessonFiles    → lessonFile
 *   quizzes         → quiz            questions      → question
 *   settings        → setting (multi-row key-value)
 *   themeConfig     → single Setting row (key: '__themeConfig')
 *   appConfig       → single Setting row (key: '__appConfig')
 *   maintenanceMode → single Setting row (key: '__maintenanceMode')
 *
 * Collections not mapped here fall back to the original firebase-admin.js.
 *
 * Usage:
 *   const { readData, writeData, readUserById, sendFCM, ... } = require('./prisma-bridge');
 *
 * @module prisma-bridge
 */

const { getPrisma } = require('./src/database');

// ── Lazy import of original Firebase (for FCM, Auth, and unmapped collections) ──
let _fbModule = null;
function _fb() {
  if (!_fbModule) {
    try { _fbModule = require('./firebase-admin'); } catch (e) { _fbModule = null; }
  }
  return _fbModule;
}

// ── Collection → Prisma model mapping ──
const COLLECTION_MODEL_MAP = {
  users: 'user',
  courses: 'course',
  payments: 'payment',
  subscriptions: 'subscription',
  reviews: 'review',
  supportTickets: 'supportTicket',
  notes: 'note',
  quotes: 'quote',
  questionBanks: 'questionBank',
  announcements: 'announcement',
  liveSessions: 'liveSession',
  parentInvites: 'parentInvite',
  chargeCodes: 'chargeCode',
  subRequests: 'subRequest',
  dismisseds: 'dismissed',
  studentAnalytics: 'studentAnalytic',
  notifications: 'notification',
  scheduledNotifications: 'scheduledNotification',
  examAttempts: 'examAttempt',
  enrollments: 'enrollment',
  lessons: 'lesson',
  units: 'unit',
  videos: 'video',
  lessonFiles: 'lessonFile',
  quizzes: 'quiz',
  questions: 'question',
};

// ── Models that have a `deletedAt` column — automatically filtered out ──
const SOFT_DELETE_MODELS = new Set([
  'user', 'course', 'lesson', 'questionBank', 'note',
  'subscription', 'subRequest', 'payment', 'chargeCode',
  'chatSession', 'notification', 'liveSession', 'examAttempt',
  'enrollment', 'review', 'supportTicket', 'announcement',
  'unit', 'video', 'lessonFile', 'quiz', 'question',
]);

// ── Collections stored as key-value objects (not arrays) ──
//   'settings'        → multi-row:  each key in the object is a Setting row
//   'themeConfig'     → single-row: whole object stored as Setting key '__themeConfig'
//   'appConfig'       → single-row: whole object stored as Setting key '__appConfig'
//   'maintenanceMode' → single-row: whole object stored as Setting key '__maintenanceMode'
const KV_COLLECTION = new Set(['settings', 'themeConfig', 'appConfig', 'maintenanceMode']);

const KV_SINGLE_ROW = new Set(['themeConfig', 'appConfig', 'maintenanceMode']);

function _kvStorageKey(collectionName) {
  return '__' + collectionName;
}

// ── Cache of valid Prisma model fields ──
const _MODEL_FIELDS_CACHE = {};

function _getModelFields(prisma, modelName) {
  if (_MODEL_FIELDS_CACHE[modelName]) return _MODEL_FIELDS_CACHE[modelName];
  try {
    // Use Prisma DMMF to get scalar field names
    const model = prisma._dmmf?.modelMap?.[modelName];
    if (model && Array.isArray(model.fields)) {
      const set = new Set(model.fields.map(f => f.name));
      _MODEL_FIELDS_CACHE[modelName] = set;
      return set;
    }
  } catch (e) {
    // silently fall through
  }
  // Fallback: empty set passes all fields through
  _MODEL_FIELDS_CACHE[modelName] = new Set();
  return _MODEL_FIELDS_CACHE[modelName];
}

// ── Helpers ──

function _modelHasSoftDelete(modelName) {
  return SOFT_DELETE_MODELS.has(modelName);
}

function _clone(v) {
  if (v === null || v === undefined) return v;
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
}

function _stripTimestamps(item) {
  if (!item || typeof item !== 'object') return item;
  const { id, createdAt, updatedAt, ...rest } = item;
  return rest;
}

// ── Fields that are DateTime in Prisma but numeric timestamps in Firebase ──
const _TIMESTAMP_FIELDS = new Set([
  'emailCodeExpiry', 'resetCodeExpiry', 'subscriptionStart', 'subscriptionEnd',
  'referralUsedAt', 'lastLogin', 'phoneVerifiedAt', 'deletedAt', 'migratedAt',
  'expiresAt', 'startDate', 'endDate', 'cancelledAt', 'completedAt',
  'startedAt', 'lastWatchAt',
]);

function _convertDatesToTimestamps(item) {
  if (Array.isArray(item)) return item.map(_convertDatesToTimestamps);
  if (!item || typeof item !== 'object') return item;
  for (const key of Object.keys(item)) {
    const val = item[key];
    if (_TIMESTAMP_FIELDS.has(key) && typeof val === 'string') {
      const ts = Date.parse(val);
      if (!isNaN(ts)) item[key] = ts;
    }
    if (typeof val === 'object' && val !== null && !Array.isArray(val) && !(val instanceof Date)) {
      _convertDatesToTimestamps(val);
    }
  }
  return item;
}

// ── Convert numeric timestamps to Date (Prisma expects DateTime) ──
function _fixTimestamps(item) {
  if (!item || typeof item !== 'object') return item;
  for (const key of Object.keys(item)) {
    const val = item[key];
    if (_TIMESTAMP_FIELDS.has(key) && typeof val === 'number' && !isNaN(val)) {
      item[key] = new Date(val);
    }
    if (typeof val === 'object' && val !== null && !Array.isArray(val) && !(val instanceof Date)) {
      _fixTimestamps(val);
    }
  }
  return item;
}

// =====================================================================
//  PUBLIC API  —  matches firebase-admin.js exports
// =====================================================================

/**
 * Read an entire collection by its Firebase key.
 *
 * @param {string}  key     Collection name (e.g. 'users', 'courses', 'settings')
 * @param {boolean} noCache Ignored (cache is not implemented in the bridge).
 * @returns {Promise<object[]|object|null>} Array for normal collections, object for KV collections.
 */
async function readData(key, noCache) {
  // ── Key-value collections (settings, themeConfig, etc.) ──
  if (KV_COLLECTION.has(key)) {
    try {
      const prisma = getPrisma();
      const allRows = await prisma.setting.findMany();

      if (key === 'settings') {
        // Convert [{ key, value }] → { key1: val1, key2: val2 }
        const obj = {};
        for (const row of allRows) {
          if (!row.key.startsWith('__')) {
            obj[row.key] = row.value;
          }
        }
        return Object.keys(obj).length ? obj : null;
      }

      // Single-row KV: themeConfig, appConfig, maintenanceMode
      const storageKey = _kvStorageKey(key);
      const row = allRows.find(r => r.key === storageKey);
      return row ? row.value : null;
    } catch (e) {
      console.error(`[prisma-bridge] readData("${key}") KV error:`, e.message);
      const fb = _fb();
      if (fb && typeof fb.readData === 'function') return fb.readData(key, noCache);
      return null;
    }
  }

  // ── Regular array collections ──
  const modelName = COLLECTION_MODEL_MAP[key];
  if (modelName) {
    try {
      const prisma = getPrisma();
      const where = _modelHasSoftDelete(modelName) ? { deletedAt: null } : {};
      const rows = await prisma[modelName].findMany({ where });
      return _convertDatesToTimestamps(_clone(rows));
    } catch (e) {
      console.error(`[prisma-bridge] readData("${key}") error:`, e.message);
      const fb = _fb();
      if (fb && typeof fb.readData === 'function') return fb.readData(key, noCache);
      return [];
    }
  }

  // ── Fallback: no Prisma mapping → try Firebase ──
  const fb = _fb();
  if (fb && typeof fb.readData === 'function') return fb.readData(key, noCache);
  console.warn(`[prisma-bridge] No handler for readData("${key}")`);
  return null;
}

/**
 * Write an entire collection by its Firebase key.
 *
 * @param {string}           key  Collection name.
 * @param {object[]|object|null} data Array (normal) or object (KV collection).
 * @returns {Promise<*>} The written data.
 */
async function writeData(key, data) {
  // ── Key-value collections ──
  if (KV_COLLECTION.has(key)) {
    try {
      const prisma = getPrisma();

      if (KV_SINGLE_ROW.has(key)) {
        // themeConfig / appConfig / maintenanceMode — upsert single Setting row
        const storageKey = _kvStorageKey(key);
        if (data === null || data === undefined) {
          await prisma.setting.deleteMany({ where: { key: storageKey } });
        } else {
          await prisma.setting.upsert({
            where: { key: storageKey },
            create: { key: storageKey, value: data },
            update: { value: data },
          });
        }
        return data;
      }

      // settings — multi-row key-value
      if (data === null || data === undefined) {
        await prisma.setting.deleteMany({ where: { key: { not: { startsWith: '__' } } } });
        return data;
      }

      // data is a plain object: { currentSemester: 'all', vodafoneCash: '...', ... }
      const entries = Object.entries(data);
      const incomingKeys = new Set(entries.map(([k]) => k));

      // Delete removed keys (in DB but not in new data)
      const existing = await prisma.setting.findMany({
        where: { key: { not: { startsWith: '__' } } },
        select: { key: true },
      });
      const keysToRemove = existing
        .map(r => r.key)
        .filter(k => !incomingKeys.has(k));

      const operations = [];

      if (keysToRemove.length) {
        operations.push(prisma.setting.deleteMany({ where: { key: { in: keysToRemove } } }));
      }

      for (const [k, v] of entries) {
        operations.push(
          prisma.setting.upsert({
            where: { key: k },
            create: { key: k, value: v },
            update: { value: v },
          })
        );
      }

      if (operations.length) {
        await prisma.$transaction(operations);
      }

      return data;
    } catch (e) {
      console.error(`[prisma-bridge] writeData("${key}") KV error:`, e.message);
      const fb = _fb();
      if (fb && typeof fb.writeData === 'function') return fb.writeData(key, data);
      return data;
    }
  }

  // ── Regular array collections ──
  const modelName = COLLECTION_MODEL_MAP[key];
  if (modelName) {
    try {
      const prisma = getPrisma();

      // Delete all if data is null/undefined/empty
      if (data === null || data === undefined || (Array.isArray(data) && data.length === 0)) {
        if (_modelHasSoftDelete(modelName)) {
          await prisma[modelName].updateMany({
            where: { deletedAt: null },
            data: { deletedAt: new Date() },
          });
        } else {
          await prisma[modelName].deleteMany({});
        }
        return data;
      }

      const items = Array.isArray(data) ? data : [data];

      // Get valid scalar fields for this model (remove extra Firebase fields)
      const validFields = _getModelFields(prisma, modelName);

      // Batch upsert each item
      await prisma.$transaction(
        items.map(item => {
          const fixed = _fixTimestamps(_clone(item));
          const clean = _stripTimestamps(fixed);
          // Keep only fields that exist in the Prisma model
          const pruned = {};
          for (const key of Object.keys(clean)) {
            if (validFields.has(key)) {
              pruned[key] = clean[key];
            }
          }
          if (item.id) {
            return prisma[modelName].upsert({
              where: { id: item.id },
              create: { ...pruned, id: item.id },
              update: pruned,
            });
          }
          return prisma[modelName].create({ data: pruned });
        })
      );

      return data;
    } catch (e) {
      console.error(`[prisma-bridge] writeData("${key}") error:`, e.message);
      const fb = _fb();
      if (fb && typeof fb.writeData === 'function') return fb.writeData(key, data);
      return data;
    }
  }

  // ── Fallback ──
  const fb = _fb();
  if (fb && typeof fb.writeData === 'function') return fb.writeData(key, data);
  console.warn(`[prisma-bridge] No handler for writeData("${key}")`);
  return data;
}

/**
 * Read a single user by id or uid.
 *
 * @param {string} id User id or legacy uid.
 * @returns {Promise<object|null>}
 */
async function readUserById(id) {
  if (!id) return null;

  try {
    const prisma = getPrisma();
    // Try direct lookup by id first
    let user = await prisma.user.findUnique({ where: { id } });
    if (user) return user;
    // Fallback: search by uid field
    user = await prisma.user.findFirst({ where: { uid: id, deletedAt: null } });
    if (user) return user;
    // Last resort: full-text search across id and uid
    user = await prisma.user.findFirst({
      where: { OR: [{ id }, { uid: id }], deletedAt: null },
    });
    return user || null;
  } catch (e) {
    console.error('[prisma-bridge] readUserById error:', e.message);
    const fb = _fb();
    if (fb && typeof fb.readUserById === 'function') return fb.readUserById(id);
    return null;
  }
}

/**
 * No-op cache invalidation — Prisma reads are always fresh within a request.
 *
 * @param {string} _key Ignored.
 */
function cacheInvalidate(_key) {
  // Prisma-backed reads bypass the in-memory cache — no-op.
}

// ── FCM passthrough (still uses Firebase Admin SDK for push) ──

/**
 * Send a push notification to a single user via FCM.
 * Delegates to the original firebase-admin.js.
 *
 * @param {string} userId
 * @param {string} title
 * @param {string} body
 * @param {string} [url]
 * @returns {Promise<boolean>}
 */
async function sendFCM(userId, title, body, url) {
  const fb = _fb();
  if (fb && typeof fb.sendFCM === 'function') return fb.sendFCM(userId, title, body, url);
  console.error('[prisma-bridge] sendFCM: Firebase module not available');
  return false;
}

/**
 * Send a push notification to all users with a given role via FCM.
 * Delegates to the original firebase-admin.js.
 *
 * @param {string} role
 * @param {string} title
 * @param {string} body
 * @param {string} [url]
 * @returns {Promise<number>} Number of successful sends.
 */
async function sendFCMToRole(role, title, body, url) {
  const fb = _fb();
  if (fb && typeof fb.sendFCMToRole === 'function') return fb.sendFCMToRole(role, title, body, url);
  console.error('[prisma-bridge] sendFCMToRole: Firebase module not available');
  return 0;
}

/**
 * Firebase Auth reference — used for verifyIdToken in app.js middleware.
 * If Firebase is unavailable, this is null and token verification will fail.
 *
 * @type {object|null}
 */
const fbAuth = _fb() ? _fb().fbAuth || null : null;

// ── Passthrough helper for firebase-admin members ──
function _fbProp(name) {
  const m = _fb();
  return m ? m[name] : undefined;
}

// Re-export everything with the exact same interface as firebase-admin.js
module.exports = {
  // Prisma-native replacements
  readData,
  writeData,
  readUserById,
  cacheInvalidate,

  // FCM — still requires Firebase Admin SDK
  sendFCM,
  sendFCMToRole,

  // Auth — Firebase Auth reference for verifyIdToken
  fbAuth,

  // Passthrough properties (delegated to firebase-admin.js)
  get db() { return _fbProp('db'); },
  get fbDb() { return _fbProp('fbDb') || _fbProp('db'); },
  get admin() { return _fbProp('admin'); },
  get fsCore() { return _fbProp('fsCore'); },
  get FIRESTORE_COLLECTIONS() { return new Set(Object.keys(COLLECTION_MODEL_MAP)); },

  // Passthrough functions (delegated to firebase-admin.js)
  get updateData() { return _fbProp('updateData'); },
  get transactionData() { return _fbProp('transactionData'); },
  get pushData() { return _fbProp('pushData'); },
  get fbRead() { return _fbProp('fbRead'); },
  get fbSet() { return _fbProp('fbSet'); },
  get fbPush() { return _fbProp('fbPush'); },
  get fbRemove() { return _fbProp('fbRemove'); },
  get restGet() { return _fbProp('restGet'); },
  get restPut() { return _fbProp('restPut'); },
};
