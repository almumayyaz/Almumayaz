const { getPrisma } = require('../database');
const { getStore } = require('../utils/cacheProvider');

const COLLECTION_MODEL_MAP = {
  users: 'user',
  courses: 'course',
  lessons: 'lesson',
  questionBanks: 'questionBank',
  subscriptions: 'subscription',
  enrollments: 'enrollment',
  payments: 'payment',
  examAttempts: 'examAttempt',
  notes: 'note',
  notifications: 'notification',
  reviews: 'review',
  announcements: 'announcement',
  tickets: 'supportTicket',
  settings: 'setting',
  chargeCodes: 'chargeCode',
  liveSessions: 'liveSession',
  liveSessionAttendance: 'liveSessionAttendance',
  chatSessions: 'chatSession',
  chatMessages: 'chatMessage',
  zoomCredentials: 'zoomCredential',
  zoomAppCredentials: 'zoomAppCredential',
  parentInvites: 'parentInvite',
  studentAnalytics: 'studentAnalytic',
  systemStats: 'systemStat',
  contactMessages: 'contactMessage',
  cronClaims: 'cronClaim',
  dismisseds: 'dismissed',
  videoProgress: 'videoProgress',
  lessonProgress: 'lessonProgress',
  units: 'unit',
  videos: 'video',
  lessonFiles: 'lessonFile',
  quizzes: 'quiz',
  questions: 'question',
  choices: 'choice',
  examAnswers: 'examAnswer',
  userSubscriptions: 'userSubscription',
  referrals: 'referral',
  childRelations: 'childRelation',
  ticketReplies: 'ticketReply',
  chatAttachments: 'chatAttachment',
  reviewVideos: 'reviewVideo',
  reviewFiles: 'reviewFile',
  subscriptionFeatures: 'subscriptionFeature',
  planAllowedCourses: 'planAllowedCourse',
  referral: 'referral',
  refreshTokens: 'refreshToken',
};

function modelName(collectionName) {
  return COLLECTION_MODEL_MAP[collectionName] || collectionName.replace(/s$/, '');
}

const SOFT_DELETE_MODELS = new Set([
  'user', 'course', 'lesson', 'questionBank', 'note',
  'subscription', 'subRequest', 'payment', 'chargeCode',
  'chatSession', 'notification', 'liveSession', 'examAttempt',
  'enrollment', 'review', 'supportTicket', 'announcement',
  'unit', 'video', 'lessonFile', 'quiz', 'question',
]);

const DEFAULT_PAGE_SIZE = 100;

class PrismaBaseRepository {
  constructor(collectionName) {
    this._collectionName = collectionName;
    this._modelName = modelName(collectionName);
    this._cache = null;
  }

  get _model() {
    return getPrisma()[this._modelName];
  }

  get _hasSoftDelete() {
    return SOFT_DELETE_MODELS.has(this._modelName);
  }

  _excludeDeleted(where) {
    if (!this._hasSoftDelete) return where;
    return { ...where, deletedAt: null };
  }

  // ── Optional caching ──
  enableCache(store) {
    this._cache = store || getStore();
  }

  async _cached(key, ttlMs, fetcher) {
    if (!this._cache) return fetcher();
    return this._cache.getOrSet(key, fetcher, ttlMs);
  }

  async _invalidateCache(key) {
    if (this._cache) await this._cache.del(key).catch(() => {});
  }

  // ── Transaction helper ──
  // Usage: repo.transaction(async (tx) => { await tx.someModel.create(...); })
  async transaction(operation) {
    const prisma = getPrisma();
    try {
      return await prisma.$transaction(async (tx) => {
        return operation(tx);
      });
    } catch (e) {
      console.error(`${this._collectionName}.transaction error:`, e.message);
      throw e;
    }
  }

  // ── CRUD ──

  async get(id, options = {}) {
    try {
      const select = options.select || undefined;
      const include = options.include || undefined;
      return await this._model.findUnique({ where: { id }, select, include });
    } catch (e) {
      console.error(`${this._collectionName}.get error:`, e.message);
      throw e;
    }
  }

  async create(data, _userId, options = {}) {
    try {
      const { id: providedId, createdAt, updatedAt, ...rest } = data;
      const select = options.select || undefined;
      const include = options.include || undefined;
      return await this._model.create({
        data: { ...rest, ...(providedId ? { id: providedId } : {}) },
        select, include,
      });
    } catch (e) {
      console.error(`${this._collectionName}.create error:`, e.message);
      throw e;
    }
  }

  async update(id, data, _userId, options = {}) {
    try {
      const { id: _, createdAt, updatedAt, ...rest } = data;
      const select = options.select || undefined;
      const include = options.include || undefined;
      return await this._model.update({
        where: { id },
        data: rest,
        select, include,
      });
    } catch (e) {
      console.error(`${this._collectionName}.update error:`, e.message);
      throw e;
    }
  }

  async softDelete(id, userId) {
    try {
      return await this._model.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: userId || null }
      });
    } catch (e) {
      return this.hardDelete(id);
    }
  }

  async hardDelete(id) {
    try {
      await this._model.delete({ where: { id } });
      return true;
    } catch (e) {
      if (e.code === 'P2025') return false;
      console.error(`${this._collectionName}.hardDelete error:`, e.message);
      throw e;
    }
  }

  // ── Query ──

  async query(filters = {}, options = {}) {
    try {
      const where = {};
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null && key !== 'deleted') {
          where[key] = value;
        }
      }
      const finalWhere = this._excludeDeleted(where);
      let orderBy = options.orderBy;
      if (typeof orderBy === 'string') orderBy = { [orderBy]: options.order || 'asc' };
      const take = options.limit || undefined;
      const cursor = options.startAfter ? { id: options.startAfter } : undefined;
      const skip = cursor ? 1 : undefined;
      const select = options.select || undefined;
      const include = options.include || undefined;
      return await this._model.findMany({ where: finalWhere, orderBy, take, cursor, skip, select, include });
    } catch (e) {
      console.error(`${this._collectionName}.query error:`, e.message);
      throw e;
    }
  }

  async list(options = {}) {
    return this.query({}, options);
  }

  async exists(id) {
    const doc = await this._model.findUnique({ where: { id }, select: { id: true } });
    return !!doc;
  }

  // ── Advanced queries ──

  async findBy(field, value, options = {}) {
    try {
      const where = { [field]: value };
      const select = options.select || undefined;
      const include = options.include || undefined;
      return await this._model.findUnique({ where, select, include });
    } catch (e) {
      if (e.code === 'P2025') return null;
      console.error(`${this._collectionName}.findBy error:`, e.message);
      throw e;
    }
  }

  async findFirst(filters = {}, options = {}) {
    try {
      const where = {};
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null) where[key] = value;
      }
      const finalWhere = this._excludeDeleted(where);
      let orderBy = options.orderBy;
      if (typeof orderBy === 'string') orderBy = { [orderBy]: options.order || 'asc' };
      const select = options.select || undefined;
      const include = options.include || undefined;
      return await this._model.findFirst({ where: finalWhere, orderBy, select, include });
    } catch (e) {
      console.error(`${this._collectionName}.findFirst error:`, e.message);
      throw e;
    }
  }

  async updateMany(where, data) {
    try {
      return await this._model.updateMany({ where, data });
    } catch (e) {
      console.error(`${this._collectionName}.updateMany error:`, e.message);
      throw e;
    }
  }

  async deleteMany(where) {
    try {
      return await this._model.deleteMany({ where });
    } catch (e) {
      console.error(`${this._collectionName}.deleteMany error:`, e.message);
      throw e;
    }
  }

  async count(filters = {}) {
    try {
      const where = {};
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null) where[key] = value;
      }
      return await this._model.count({ where: this._excludeDeleted(where) });
    } catch (e) {
      console.error(`${this._collectionName}.count error:`, e.message);
      throw e;
    }
  }

  // ── Upsert ──

  async upsert(where, create, update) {
    try {
      return await this._model.upsert({
        where,
        create,
        update,
      });
    } catch (e) {
      console.error(`${this._collectionName}.upsert error:`, e.message);
      throw e;
    }
  }

  // ── Batch operations ──

  async batchCreate(items, _userId) {
    if (!items.length) return [];
    try {
      const data = items.map(item => {
        const { id: providedId, createdAt, updatedAt, ...rest } = item;
        return { ...rest, ...(providedId ? { id: providedId } : {}) };
      });
      return await this._model.createManyAndReturn({ data });
    } catch (e) {
      console.error(`${this._collectionName}.batchCreate error:`, e.message);
      throw e;
    }
  }

  // Safe batch create — wraps each item individually so partial failures don't block all
  async batchCreateSafe(items, _userId) {
    if (!items.length) return [];
    const results = [];
    for (const item of items) {
      try {
        const created = await this.create(item, _userId);
        results.push({ success: true, data: created });
      } catch (e) {
        results.push({ success: false, error: e.message, item });
      }
    }
    return results;
  }

  async batchUpdate(items, _userId) {
    if (!items.length) return;
    const prisma = getPrisma();
    try {
      await prisma.$transaction(
        items.map(item => {
          const { id, ...data } = item;
          if (!id) return null;
          return this._model.update({ where: { id }, data });
        }).filter(Boolean)
      );
    } catch (e) {
      console.error(`${this._collectionName}.batchUpdate error:`, e.message);
      throw e;
    }
  }

  async batchDelete(ids) {
    if (!ids.length) return;
    try {
      await this._model.deleteMany({ where: { id: { in: ids } } });
    } catch (e) {
      console.error(`${this._collectionName}.batchDelete error:`, e.message);
      throw e;
    }
  }

  // ── Soft-delete cascade foundation ──
  // Deletes a record and all related records in one transaction.
  // related: [{ modelName: 'video', parentField: 'courseId' }]
  async softDeleteCascade(id, userId, related = []) {
    const prisma = getPrisma();
    try {
      return await prisma.$transaction(async (tx) => {
        // Delete related records first
        for (const rel of related) {
          const model = tx[rel.modelName];
          if (!model) continue;
          const filter = { [rel.parentField]: id };
          await model.updateMany({
            where: { ...filter, deletedAt: null },
            data: { deletedAt: new Date(), deletedBy: userId || null }
          });
        }
        // Delete the main record
        const mainModel = tx[this._modelName];
        return await mainModel.update({
          where: { id },
          data: { deletedAt: new Date(), deletedBy: userId || null }
        });
      });
    } catch (e) {
      console.error(`${this._collectionName}.softDeleteCascade error:`, e.message);
      throw e;
    }
  }

  // ── Pagination (defaults to 100) ──

  async paginate(filters = {}, options = {}) {
    const pageSize = options.limit || DEFAULT_PAGE_SIZE;
    const items = await this.query(filters, { ...options, limit: pageSize + 1 });
    const hasMore = items.length > pageSize;
    const page = hasMore ? items.slice(0, pageSize) : items;
    const lastItem = page[page.length - 1];
    return {
      items: page,
      total: await this.count(filters),
      hasMore,
      cursor: lastItem ? { id: lastItem.id } : null
    };
  }

  // ── Aggregation helpers ──

  async sum(field, filters = {}) {
    const where = this._excludeDeleted(filters);
    const result = await this._model.aggregate({ where, _sum: { [field]: true } });
    return result._sum[field] || 0;
  }

  async avg(field, filters = {}) {
    const where = this._excludeDeleted(filters);
    const result = await this._model.aggregate({ where, _avg: { [field]: true } });
    return result._avg[field] || 0;
  }
}

module.exports = PrismaBaseRepository;
module.exports.modelName = modelName;
module.exports.SOFT_DELETE_MODELS = SOFT_DELETE_MODELS;
module.exports.COLLECTION_MODEL_MAP = COLLECTION_MODEL_MAP;
