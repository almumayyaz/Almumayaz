const log = require('./logger');

const CACHEABLE = new Set(['settings', 'theme', 'announcements', 'courses']);
const TTL = { default: 20000, settings: 30000, theme: 60000 };
const _cache = new Map();

function cacheTtl(key) { return TTL[key] || TTL.default; }

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return;
  if (Date.now() > e.expires) { _cache.delete(key); return; }
  log.debug('Cache', 'HIT', key);
  return e.value;
}

function cacheSet(key, val) {
  if (!CACHEABLE.has(key)) return;
  _cache.set(key, { value: val, expires: Date.now() + cacheTtl(key) });
}

function cacheInvalidate(key) {
  _cache.delete(key);
  log.debug('Cache', 'INVALIDATED', key);
}

function cacheClear() { _cache.clear(); }

module.exports = { cacheGet, cacheSet, cacheInvalidate, cacheClear };
