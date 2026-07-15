'use strict';
// Internal performance/observability logger.
// Tracks per-request and global: execution time, Firebase reads, Firebase writes,
// cache hits and cache misses. Nothing here is ever sent to the client.
//
// Per-request tracking uses AsyncLocalStorage (available in Node >= 14), so every
// readData/writeData call made while handling a request is attributed to that request.

const { AsyncLocalStorage } = (() => {
  try { return require('async_hooks'); } catch (e) { return {}; }
})();

const als = (typeof AsyncLocalStorage !== 'undefined') ? new AsyncLocalStorage() : null;

const globalMetrics = {
  reads: 0,
  writes: 0,
  cacheHits: 0,
  cacheMisses: 0,
  requests: 0
};

function _store() {
  if (als) {
    const s = als.getStore();
    if (s) return s;
  }
  return null;
}

function trackRead() { globalMetrics.reads++; const s = _store(); if (s) s.reads++; }
function trackWrite() { globalMetrics.writes++; const s = _store(); if (s) s.writes++; }
function trackCacheHit() { globalMetrics.cacheHits++; const s = _store(); if (s) s.cacheHits++; }
function trackCacheMiss() { globalMetrics.cacheMisses++; const s = _store(); if (s) s.cacheMisses++; }

// Express middleware: starts a per-request context and records execution time.
function middleware(req, res, next) {
  const store = {
    start: process.hrtime.bigint(),
    reads: 0,
    writes: 0,
    cacheHits: 0,
    cacheMisses: 0
  };
  if (als) {
    als.run(store, () => next());
  } else {
    req.__perf = store;
    next();
  }
  res.on('finish', () => {
    store.durationMs = Number(process.hrtime.bigint() - store.start) / 1e6;
    globalMetrics.requests++;
    if (process.env.PERF_DEBUG) {
      // Server-side only; never reaches the client.
      console.log('[perf]', req.method, req.originalUrl || req.url,
        'ms=' + store.durationMs.toFixed(1),
        'reads=' + store.reads, 'writes=' + store.writes,
        'hit=' + store.cacheHits, 'miss=' + store.cacheMisses);
    }
  });
}

// Returns a snapshot of the global counters (does not reset them).
function getGlobalMetrics() {
  return Object.assign({}, globalMetrics);
}

// Returns the per-request metrics object attached to a request, if any.
function getRequestMetrics(req) {
  if (als) {
    const s = als.getStore();
    if (s) return Object.assign({}, s);
  }
  if (req && req.__perf) return Object.assign({}, req.__perf);
  return null;
}

function resetMetrics() {
  globalMetrics.reads = 0;
  globalMetrics.writes = 0;
  globalMetrics.cacheHits = 0;
  globalMetrics.cacheMisses = 0;
  globalMetrics.requests = 0;
}

module.exports = {
  middleware,
  trackRead,
  trackWrite,
  trackCacheHit,
  trackCacheMiss,
  getGlobalMetrics,
  getRequestMetrics,
  resetMetrics
};
