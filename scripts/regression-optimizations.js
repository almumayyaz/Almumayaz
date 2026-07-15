'use strict';
// Regression harness for the performance/scalability optimizations.
// Runs entirely in the LOCAL fallback mode (no Firebase/Supabase network),
// so it validates caching, partial updates, transactions, single-user reads,
// logging counters and analytics partial-persist without touching production.
//
// It does NOT require app.js (which would run auto-migrate and mutate repo data).

// Force local fallback BEFORE requiring the modules.
delete process.env.FIREBASE_DATABASE_URL;
delete process.env.FIREBASE_SERVICE_ACCOUNT;
process.env.NODE_ENV = 'test';

const path = require('path');
const fs = require('fs');
const dataDir = path.join(__dirname, '..', 'data');
const generated = [];

const fa = require('../firebase-admin');
const { readData, writeData, updateData, transactionData, readUserById } = fa;
const perf = require('../perf');
const { getGlobalMetrics, resetMetrics } = perf;
const analytics = require('../analytics-engine');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  PASS:', msg); }
  else { console.log('  FAIL:', msg); failures++; }
}
function approxEqual(a, b, msg) { assert(Math.abs(a - b) < 1e-6, msg + ' (' + a + ' ~= ' + b + ')'); }

(async () => {
  // ---- Stage 2/6/14: cache hits eliminate Firebase/local reads ----
  console.log('\n[Stage 2/6/14] read-through cache');
  resetMetrics();
  await readData('courses');           // miss -> read
  const afterFirst = getGlobalMetrics();
  await readData('courses');           // hit
  await readData('courses');           // hit
  const afterThird = getGlobalMetrics();
  assert(afterThird.cacheHits >= 2, 'courses read served from cache on 2nd/3rd read');
  assert(afterThird.reads === afterFirst.reads, 'no extra storage read after cache warm');
  assert(afterFirst.cacheMisses >= 1, 'first courses read was a cache miss');

  // settings also cached
  resetMetrics();
  await readData('settings'); await readData('settings');
  assert(getGlobalMetrics().cacheHits >= 1, 'settings served from cache');

  // ---- Stage 1: write invalidates cache, then read is a fresh miss ----
  console.log('\n[Stage 1/2] cache invalidation on write');
  resetMetrics();
  await readData('courses');           // warm
  await writeData('courses', await readData('courses')); // write -> invalidate
  const m1 = getGlobalMetrics();
  await readData('courses');           // must be a miss (invalidated)
  const m2 = getGlobalMetrics();
  assert(m2.cacheMisses > m1.cacheMisses, 'write invalidated cache so next read is a miss');
  assert(m2.reads > m1.reads, 'write + re-read performed a real storage read');

  // ---- Stage 1: readUserById returns a single user without throwing ----
  console.log('\n[Stage 1] readUserById');
  const users = await readData('users');
  const someUser = Array.isArray(users) ? users[0] : Object.values(users)[0];
  if (someUser) {
    const found = await readUserById(someUser.id);
    assert(found && found.id === someUser.id, 'readUserById found the user by id');
  } else {
    assert(true, 'no users in local store (skipped)');
  }

  // ---- Stage 4/5: updateData merges only the given fields (keyed node) ----
  console.log('\n[Stage 4/5] updateData partial merge');
  const tuid = 'regression_test_user';
  const base = { profile: { name: 'X' }, watchHistory: { totalSeconds: 0 }, quizHistory: { q1: { a: 1 } } };
  await writeData('studentAnalytics/' + tuid, base);
  await updateData('studentAnalytics/' + tuid, { watchHistory: { totalSeconds: 42 } });
  const merged = await readData('studentAnalytics/' + tuid);
  assert(merged.watchHistory.totalSeconds === 42, 'updateData applied the partial watchHistory');
  assert(merged.profile && merged.profile.name === 'X', 'updateData left profile untouched');
  assert(merged.quizHistory && merged.quizHistory.q1 && merged.quizHistory.q1.a === 1, 'updateData left quizHistory untouched');

  // ---- Stage 5: transactionData atomic read-modify-write ----
  console.log('\n[Stage 5] transactionData');
  await writeData('counters/reg', { n: 0 });
  await transactionData('counters/reg', (cur) => ({ n: ((cur && cur.n) || 0) + 5 }));
  const c = await readData('counters/reg');
  assert(c.n === 5, 'transactionData mutated the counter atomically');

  // ---- Stage 3/4: analytics heartbeat partial persist keeps other fields ----
  console.log('\n[Stage 3/4] analytics heartbeat partial persist');
  const hbUid = 'regression_heartbeat_uid';
  await fa.writeData('studentAnalytics/' + hbUid, null).catch(() => {});
  // Remove any prior state
  await updateData('studentAnalytics/' + hbUid, { quizHistory: { existing: true }, profile: { name: 'orig' } });
  const r1 = await analytics.trackVideoHeartbeat(hbUid, 'c1', 'l1', 10, 100, 9, false);
  assert(r1 && typeof r1.completionPercent === 'number', 'trackVideoHeartbeat returned a result');
  const after = await readData('studentAnalytics/' + hbUid);
  assert(after.watchHistory && after.watchHistory.lessons && after.watchHistory.lessons['c1_l1'], 'heartbeat wrote watchHistory');
  assert(after.quizHistory && after.quizHistory.existing === true, 'heartbeat did NOT wipe pre-existing quizHistory');
  assert(after.profile && after.profile.name === 'orig', 'heartbeat did NOT wipe profile');

  // ---- Stage 15: logging counters incremented ----
  console.log('\n[Stage 15] internal metrics');
  resetMetrics();
  await readData('announcements'); // miss
  await readData('announcements'); // hit
  const mm = getGlobalMetrics();
  assert(mm.reads >= 1, 'reads counter incremented');
  assert(mm.cacheHits >= 1, 'cacheHits counter incremented');
  assert(mm.cacheMisses >= 1, 'cacheMisses counter incremented');

  // ---- cleanup generated local files ----
  for (const f of ['studentAnalytics.json', 'counters.json']) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (e) {} }
  }

  console.log('\n=========================================');
  console.log(failures === 0 ? 'ALL REGRESSION CHECKS PASSED' : (failures + ' CHECK(S) FAILED'));
  console.log('=========================================');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
