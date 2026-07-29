/**
 * Runtime Verification Script
 * Tests the prisma-bridge.js compatibility layer to ensure
 * all data operations work correctly via Prisma.
 */
require('dotenv').config();
const { readData, writeData, readUserById } = require('../prisma-bridge');

let passed = 0;
let failed = 0;
const errors = [];

async function test(name, fn) {
  try {
    const result = await fn();
    console.log(`  ✅ ${name}`);
    passed++;
    return result;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
    errors.push({ name, error: e.message });
    return null;
  }
}

async function verify() {
  console.log('\n═══════════════════════════════════════════');
  console.log('  RUNTIME VERIFICATION');
  console.log('═══════════════════════════════════════════\n');

  // 1. readData('users')
  const users = await test('readData("users") returns array (with Prisma or Firestore)', async () => {
    const u = await readData('users');
    if (!Array.isArray(u)) throw new Error('Expected array, got ' + typeof u);
    if (u.length === 0) throw new Error('Expected at least 1 user, got 0');
    if (!u[0].id) throw new Error('User missing id field');
    if (!u[0].name) throw new Error('User missing name field');
    console.log(`     → ${u.length} users found`);
    return u;
  });

  // 2. readData('courses')
  const courses = await test('readData("courses") returns courses', async () => {
    const c = await readData('courses');
    if (!Array.isArray(c)) throw new Error('Expected array, got ' + typeof c);
    if (c.length === 0) throw new Error('Expected at least 1 course, got 0');
    if (!c[0].id) throw new Error('Course missing id');
    console.log(`     → ${c.length} courses found`);
    return c;
  });

  // 3. readData('lessons') — only in Prisma
  await test('readData("lessons") returns lessons via Prisma', async () => {
    const l = await readData('lessons');
    if (!Array.isArray(l)) throw new Error('Expected array, got ' + typeof l);
    console.log(`     → ${l.length} lessons found (Prisma)`);
    return l;
  });

  // 4. readData('videos')
  await test('readData("videos") returns videos via Prisma', async () => {
    const v = await readData('videos');
    if (!Array.isArray(v)) throw new Error('Expected array, got ' + typeof v);
    console.log(`     → ${v.length} videos found (Prisma)`);
    return v;
  });

  // 5. readData('quizzes')
  await test('readData("quizzes") returns quizzes via Prisma', async () => {
    const q = await readData('quizzes');
    if (!Array.isArray(q)) throw new Error('Expected array, got ' + typeof q);
    console.log(`     → ${q.length} quizzes found (Prisma)`);
    return q;
  });

  // 6. readData('questions')
  await test('readData("questions") returns questions via Prisma', async () => {
    const q = await readData('questions');
    if (!Array.isArray(q)) throw new Error('Expected array, got ' + typeof q);
    console.log(`     → ${q.length} questions found (Prisma)`);
    return q;
  });

  // 7. readData('choices')
  await test('readData("choices") returns choices via Prisma', async () => {
    const c = await readData('choices');
    if (!Array.isArray(c)) throw new Error('Expected array, got ' + typeof c);
    console.log(`     → ${c.length} choices found (Prisma)`);
    return c;
  });

  // 8. readData('settings')
  await test('readData("settings") returns key-value object', async () => {
    const s = await readData('settings');
    if (typeof s !== 'object' || Array.isArray(s)) throw new Error('Expected object, got ' + typeof s);
    console.log(`     → ${Object.keys(s || {}).length} settings keys`);
    return s;
  });

  // 9. readUserById
  if (users && users.length > 0) {
    const firstUser = users[0];
    await test('readUserById(' + firstUser.id.substring(0, 12) + '...) returns user', async () => {
      const u = await readUserById(firstUser.id);
      if (!u) throw new Error('User not found');
      if (u.id !== firstUser.id) throw new Error('ID mismatch');
      console.log(`     → Found user: ${u.name}`);
      return u;
    });
  }

  // 10. Payments and notifications (Firestore-backed, any count is valid)
  await test('readData("payments") works', async () => {
    const p = await readData('payments');
    if (!Array.isArray(p)) throw new Error('Expected array, got ' + typeof p);
    console.log(`     → ${p.length} payments found`);
    return p;
  });

  await test('readData("notifications") works', async () => {
    const n = await readData('notifications');
    if (!Array.isArray(n)) throw new Error('Expected array, got ' + typeof n);
    console.log(`     → ${n.length} notifications found`);
    return n;
  });

  // 11. writeData + readData roundtrip on settings (safe)
  await test('writeData + readData roundtrip on settings', async () => {
    const orig = await readData('settings');
    if (!orig || typeof orig !== 'object') throw new Error('Cannot read settings');
    const testKey = '_test_verify_key';
    const modified = { ...orig, [testKey]: 'test_value' };
    await writeData('settings', modified);
    const reRead = await readData('settings');
    if (!reRead || reRead[testKey] !== 'test_value') throw new Error('Write-back failed');
    // Clean up — write orig back (no test key)
    await writeData('settings', orig);
    const final = await readData('settings');
    if (final[testKey]) {
      // Retry cleanup via direct DB
      const { getPrisma } = require('../src/database');
      await getPrisma().setting.deleteMany({ where: { key: testKey } });
      const final2 = await readData('settings');
      if (final2[testKey]) throw new Error('Cleanup failed even after retry');
    }
    return true;
  });

  // 12. Unmapped collection falls back gracefully
  await test('readData("unmapped_xyz") falls back gracefully', async () => {
    const r = await readData('chats');
    // This will fall back to Firebase or return null — either is acceptable
    return r;
  });

  console.log('\n═══════════════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  if (errors.length > 0) {
    console.log('  ERRORS:');
    for (const e of errors) console.log(`    - ${e.name}: ${e.error}`);
  }
  console.log('═══════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

verify();
