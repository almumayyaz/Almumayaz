// CacheProvider — abstraction layer over caching
// Currently uses in-memory Map; swap RedisStore for Redis support
// without changing any calling code.

class MemoryStore {
  constructor() {
    this._data = new Map();
    this._timers = new Map();
  }

  async get(key) {
    const entry = this._data.get(key);
    if (!entry) return null;
    if (entry.ttl && Date.now() > entry.expiresAt) {
      this._data.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key, value, ttlMs) {
    this._data.set(key, { value, ttl: !!ttlMs, expiresAt: ttlMs ? Date.now() + ttlMs : null });
    if (ttlMs) {
      const timer = setTimeout(() => this._data.delete(key), ttlMs);
      timer.unref();
      this._timers.set(key, timer);
    }
  }

  async del(key) {
    this._data.delete(key);
    const timer = this._timers.get(key);
    if (timer) { clearTimeout(timer); this._timers.delete(key); }
  }

  async clear() {
    this._data.clear();
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
  }

  async has(key) {
    const val = await this.get(key);
    return val !== null;
  }

  async getOrSet(key, factory, ttlMs) {
    const existing = await this.get(key);
    if (existing !== null) return existing;
    const value = await factory();
    await this.set(key, value, ttlMs);
    return value;
  }
}

let _store = null;

function getStore() {
  if (!_store) {
    _store = new MemoryStore();
  }
  return _store;
}

// For Redis migration later: replace MemoryStore with RedisStore
// class RedisStore {
//   constructor(redisClient) { this.client = redisClient; }
//   async get(key) { return this.client.get(key); }
//   async set(key, value, ttlMs) { return this.client.set(key, value, { PX: ttlMs }); }
//   async del(key) { return this.client.del(key); }
//   async clear() { return this.client.flushDb(); }
//   async has(key) { return this.client.exists(key); }
//   async getOrSet(key, factory, ttlMs) { ... }
// }
//
// function useRedis(redisClient) {
//   _store = new RedisStore(redisClient);
// }

function useStore(customStore) {
  _store = customStore;
}

module.exports = { getStore, useStore };
