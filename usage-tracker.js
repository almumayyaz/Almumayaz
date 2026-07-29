'use strict';
// Usage tracker — records API consumption counters to Firebase under _usage/
// Uses Firebase transactions for atomic increments across serverless instances.

const { admin } = require('./prisma-bridge');

const today = () => new Date().toISOString().slice(0, 10);

async function track(service, action) {
  try {
    const day = today();
    const base = '_usage/services/' + service;
    const ref = admin.database().ref(base);
    await ref.transaction(function(current) {
      if (!current) current = { total: 0, daily: {}, lastAction: '' };
      current.total = (current.total || 0) + 1;
      if (!current.daily[day]) current.daily[day] = 0;
      current.daily[day]++;
      current.lastAction = action || '';
      current.lastUsed = Date.now();
      return current;
    });
  } catch (e) {
    console.error('[UsageTracker] track error:', e.message);
  }
}

async function trackRateLimit(limitName) {
  try {
    const day = today();
    const ref = admin.database().ref('_usage/rateLimits/' + limitName);
    await ref.transaction(function(current) {
      if (!current) current = { total: 0, daily: {}, lastHit: 0 };
      current.total = (current.total || 0) + 1;
      if (!current.daily[day]) current.daily[day] = 0;
      current.daily[day]++;
      current.lastHit = Date.now();
      return current;
    });
  } catch (e) {
    console.error('[UsageTracker] rateLimit error:', e.message);
  }
}

async function trackFirebaseOp(opType) {
  try {
    const day = today();
    const ref = admin.database().ref('_usage/firebase/' + opType);
    await ref.transaction(function(current) {
      if (!current) current = { total: 0, daily: {} };
      current.total = (current.total || 0) + 1;
      if (!current.daily[day]) current.daily[day] = 0;
      current.daily[day]++;
      current.lastUsed = Date.now();
      return current;
    });
  } catch (e) {
    console.error('[UsageTracker] firebaseOp error:', e.message);
  }
}

// Fetch all usage stats from Firebase
async function getStats() {
  try {
    const snap = await admin.database().ref('_usage').once('value');
    return snap.val() || {};
  } catch (e) {
    console.error('[UsageTracker] getStats error:', e.message);
    return {};
  }
}

// Reset all usage counters
async function resetStats() {
  try {
    await admin.database().ref('_usage').set({});
    return true;
  } catch (e) {
    console.error('[UsageTracker] resetStats error:', e.message);
    return false;
  }
}

module.exports = { track, trackRateLimit, trackFirebaseOp, getStats, resetStats };
