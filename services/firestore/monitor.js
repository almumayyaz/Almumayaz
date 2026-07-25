const log = require('./logger');

const metrics = {
  reads: 0,
  writes: 0,
  updates: 0,
  deletes: 0,
  transactions: 0,
  errors: 0,
  slowQueries: [],
  startTime: Date.now(),
};

function trackRead() { metrics.reads++; }
function trackWrite() { metrics.writes++; }
function trackUpdate() { metrics.updates++; }
function trackDelete() { metrics.deletes++; }
function trackTransaction() { metrics.transactions++; }
function trackError(label, msg) {
  metrics.errors++;
  log.error('Monitor', label, msg);
}

function trackSlowQuery(collection, duration) {
  metrics.slowQueries.push({ collection, duration, time: new Date().toISOString() });
  if (metrics.slowQueries.length > 100) metrics.slowQueries.shift();
  if (duration > 1000) log.warn('Monitor', `Slow query: ${collection} took ${duration}ms`);
}

function getStats() {
  const uptime = Date.now() - metrics.startTime;
  return {
    uptime,
    uptimeFormatted: formatMs(uptime),
    reads: metrics.reads,
    writes: metrics.writes,
    updates: metrics.updates,
    deletes: metrics.deletes,
    transactions: metrics.transactions,
    totalOps: metrics.reads + metrics.writes + metrics.updates + metrics.deletes,
    errors: metrics.errors,
    errorRate: metrics.totalOps > 0 ? ((metrics.errors / (metrics.reads + metrics.writes + metrics.updates + metrics.deletes)) * 100).toFixed(2) + '%' : '0%',
    slowQueries: metrics.slowQueries.slice(-10),
    slowQueryCount: metrics.slowQueries.length,
  };
}

function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

function reset() {
  metrics.reads = 0;
  metrics.writes = 0;
  metrics.updates = 0;
  metrics.deletes = 0;
  metrics.transactions = 0;
  metrics.errors = 0;
  metrics.startTime = Date.now();
}

module.exports = { trackRead, trackWrite, trackUpdate, trackDelete, trackTransaction, trackError, trackSlowQuery, getStats, reset };
