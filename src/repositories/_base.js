const { getFirestore, FieldValue } = require('../db');
const crypto = require('crypto');

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

class BaseRepository {
  constructor(collectionName) {
    this._collectionName = collectionName;
    this._db = null;
    this._collection = null;
  }

  _init() {
    if (!this._db) {
      this._db = getFirestore();
      this._collection = this._db.collection(this._collectionName);
    }
    return this._collection;
  }

  _doc(id) {
    return this._init().doc(id);
  }

  _snapToDoc(snap) {
    if (!snap.exists) return null;
    return { id: snap.id, ...snap.data() };
  }

  _snapsToDocs(snaps) {
    return snaps.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  _now() {
    return FieldValue.serverTimestamp();
  }

  _makeBase(data, userId) {
    return {
      ...data,
      createdAt: data.createdAt || this._now(),
      updatedAt: this._now(),
      createdBy: data.createdBy || userId || null,
      updatedBy: userId || data.updatedBy || null,
      status: data.status || 'active',
      version: data.version || 1,
      deleted: data.deleted || false,
      deletedAt: data.deletedAt || null,
      deletedBy: data.deletedBy || null
    };
  }

  async get(id) {
    try {
      const snap = await this._doc(id).get();
      return this._snapToDoc(snap);
    } catch (e) {
      console.error(`${this._collectionName}.get error:`, e.message);
      throw e;
    }
  }

  async create(data, userId) {
    try {
      const id = data.id || generateId(this._collectionName.replace(/s$/, ''));
      const doc = this._makeBase({ ...data, id }, userId);
      await this._doc(id).set(doc);
      return { ...doc, createdAt: new Date(), updatedAt: new Date() };
    } catch (e) {
      console.error(`${this._collectionName}.create error:`, e.message);
      throw e;
    }
  }

  async update(id, data, userId) {
    try {
      const updates = {
        ...data,
        updatedAt: this._now(),
        updatedBy: userId || data.updatedBy || null,
        version: FieldValue.increment(1)
      };
      delete updates.id;
      await this._doc(id).update(updates);
      return this.get(id);
    } catch (e) {
      console.error(`${this._collectionName}.update error:`, e.message);
      throw e;
    }
  }

  async softDelete(id, userId) {
    return this.update(id, {
      deleted: true,
      deletedAt: this._now(),
      deletedBy: userId || null,
      status: 'archived'
    }, userId);
  }

  async hardDelete(id) {
    try {
      await this._doc(id).delete();
      return true;
    } catch (e) {
      console.error(`${this._collectionName}.hardDelete error:`, e.message);
      throw e;
    }
  }

  async query(filters = {}, options = {}) {
    try {
      let query = this._init();
      for (const [field, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null) {
          if (field === 'deleted') continue;
          query = query.where(field, '==', value);
        }
      }
      if (options.orderBy) {
        query = query.orderBy(options.orderBy, options.order || 'asc');
      }
      if (options.limit) {
        query = query.limit(options.limit);
      }
      if (options.startAfter) {
        query = query.startAfter(options.startAfter);
      }
      if (options.startAt) {
        query = query.startAt(options.startAt);
      }
      const snaps = await query.get();
      return this._snapsToDocs(snaps);
    } catch (e) {
      if (e.code === 9 && options.orderBy) {
        const opts = { ...options };
        delete opts.orderBy;
        delete opts.order;
        delete opts.startAfter;
        delete opts.startAt;
        let docs = await this.query(filters, opts);
        const dir = options.order === 'desc' ? -1 : 1;
        const field = options.orderBy;
        docs.sort((a, b) => {
          const va = a[field], vb = b[field];
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          return va < vb ? -dir : va > vb ? dir : 0;
        });
        if (options.limit) docs = docs.slice(0, options.limit);
        return docs;
      }
      console.error(`${this._collectionName}.query error:`, e.message);
      throw e;
    }
  }

  async list(options = {}) {
    return this.query({ deleted: false }, options);
  }

  async exists(id) {
    const snap = await this._doc(id).get();
    return snap.exists;
  }

  async count(filters = {}) {
    try {
      let query = this._init();
      for (const [field, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null) {
          query = query.where(field, '==', value);
        }
      }
      const snap = await query.count().get();
      return snap.data().count;
    } catch (e) {
      console.error(`${this._collectionName}.count error:`, e.message);
      const all = await this.query(filters);
      return all.length;
    }
  }

  async batchCreate(items, userId) {
    if (!items.length) return [];
    try {
      const batch = this._db.batch();
      const results = [];
      for (const item of items) {
        const id = item.id || generateId(this._collectionName.replace(/s$/, ''));
        const doc = this._makeBase({ ...item, id }, userId);
        batch.set(this._doc(id), doc);
        results.push(doc);
      }
      await batch.commit();
      return results.map(r => ({ ...r, createdAt: new Date(), updatedAt: new Date() }));
    } catch (e) {
      console.error(`${this._collectionName}.batchCreate error:`, e.message);
      throw e;
    }
  }

  async batchUpdate(items, userId) {
    if (!items.length) return;
    try {
      const batch = this._db.batch();
      for (const item of items) {
        const { id, ...data } = item;
        if (!id) continue;
        batch.update(this._doc(id), {
          ...data,
          updatedAt: this._now(),
          updatedBy: userId || null,
          version: FieldValue.increment(1)
        });
      }
      await batch.commit();
    } catch (e) {
      console.error(`${this._collectionName}.batchUpdate error:`, e.message);
      throw e;
    }
  }

  async batchDelete(ids) {
    if (!ids.length) return;
    try {
      const batch = this._db.batch();
      for (const id of ids) {
        batch.delete(this._doc(id));
      }
      await batch.commit();
    } catch (e) {
      console.error(`${this._collectionName}.batchDelete error:`, e.message);
      throw e;
    }
  }

  async transaction(operation) {
    try {
      return await this._db.runTransaction(operation);
    } catch (e) {
      console.error(`${this._collectionName}.transaction error:`, e.message);
      throw e;
    }
  }

  async paginate(filters = {}, options = {}) {
    const pageSize = options.limit || 20;
    const page = await this.query(filters, { ...options, limit: pageSize + 1 });
    const hasMore = page.length > pageSize;
    const items = hasMore ? page.slice(0, pageSize) : page;
    const lastItem = items[items.length - 1];
    return {
      items,
      hasMore,
      cursor: lastItem ? { id: lastItem.id, orderBy: options.orderBy } : null
    };
  }
}

module.exports = BaseRepository;
module.exports.generateId = generateId;
