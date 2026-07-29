#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPrisma, disconnectPrisma } = require('../src/database');

const prisma = getPrisma();
let exitCode = 0;

function pass(label, detail = '') {
  console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
}

function fail(label, detail = '') {
  console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
  exitCode = 1;
}

async function main() {
  console.log('══════════════════════════════════════════════════');
  console.log('  Phase 3 — Preflight Check');
  console.log(`  ${new Date().toISOString()}`);
  console.log('══════════════════════════════════════════════════\n');

  // ── 1. DATABASE_URL ──
  console.log('── 1. Environment ──');
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    pass('DATABASE_URL', `found (${dbUrl.substring(0, 20)}...)`);
  } else {
    fail('DATABASE_URL', 'not set in .env');
  }

  const pkgVersion = require('../package.json').dependencies['@prisma/client'] || 'unknown';
  pass('Prisma version (expected)', pkgVersion);

  // ── 2. Database Connection ──
  console.log('\n── 2. Database Connection ──');
  try {
    await prisma.$connect();
    pass('Database connection');
  } catch (e) {
    fail('Database connection', e.message);
    // Cannot proceed without connection
    await disconnectPrisma();
    process.exit(exitCode);
  }

  // ── 3. Prisma Client ──
  console.log('\n── 3. Prisma Client ──');
  try {
    const installedVersion = require('@prisma/client/package.json').version;
    pass('Prisma Client loaded', `version ${installedVersion}`);
    if (pkgVersion.replace('^', '') !== installedVersion) {
      fail('Prisma version mismatch', `expected ${pkgVersion}, installed ${installedVersion}`);
    }
  } catch (e) {
    fail('Prisma Client', e.message);
  }

  // ── 4. Required Tables ──
  console.log('\n── 4. Required Tables ──');
  const REQUIRED_TABLES = [
    'Unit', 'Video', 'LessonFile', 'Quiz', 'Question', 'Choice',
    'LessonProgress', 'UserSubscription', 'Referral', 'ChildRelation',
    'SubscriptionFeature', 'ReviewVideo', 'ReviewFile',
    'User', 'Course', 'Lesson', 'Review', 'Subscription',
  ];

  let tablesOk = true;
  try {
    const result = await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const existingTables = new Set(result.map(r => r.table_name));
    for (const table of REQUIRED_TABLES) {
      const prismaTable = table.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      if (existingTables.has(prismaTable)) {
        pass(`Table \`${prismaTable}\``);
      } else {
        fail(`Table \`${prismaTable}\``);
        tablesOk = false;
      }
    }
  } catch (e) {
    fail('Table check', e.message);
    tablesOk = false;
  }

  // ── 5. Unique Indexes ──
  console.log('\n── 5. Unique Indexes ──');
  const REQUIRED_UNIQUES = [
    { table: 'lesson_progress', columns: 'student_id, lesson_id' },
    { table: 'child_relation', columns: 'parent_id, child_id' },
    { table: 'referral', columns: 'referred_id' },
    { table: 'user', columns: 'email' },
  ];
  try {
    const indexResult = await prisma.$queryRawUnsafe(
      `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE tablename IN ('lesson_progress', 'child_relation', 'referral', 'user')`
    );
    const indexMap = {};
    for (const row of indexResult) {
      if (!indexMap[row.tablename]) indexMap[row.tablename] = [];
      indexMap[row.tablename].push(row.indexdef);
    }
    for (const required of REQUIRED_UNIQUES) {
      const idxDefs = indexMap[required.table] || [];
      const found = idxDefs.some(d => d.includes('UNIQUE') && d.includes(required.columns));
      if (found) {
        pass(`Unique index \`${required.table}(${required.columns})\``);
      } else {
        fail(`Unique index \`${required.table}(${required.columns})\``);
        tablesOk = false;
      }
    }
  } catch (e) {
    fail('Index check', e.message);
  }

  // ── 6. Pending Migrations ──
  console.log('\n── 6. Migrations ──');
  const migrationDir = require('path').join(__dirname, '..', 'prisma', 'migrations');
  const fs = require('fs');
  if (fs.existsSync(migrationDir)) {
    const migrations = fs.readdirSync(migrationDir).filter(f => /^\d/.test(f));
    if (migrations.length > 0) {
      pass('Prisma migrations found', `${migrations.length} migration(s)`);
      // Check for unapplied — run _prisma_migrations table
      try {
        const tblCheck = await prisma.$queryRawUnsafe(
          `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '_prisma_migrations')::int as exists`
        );
        if (tblCheck[0].exists) {
          const applied = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int as cnt FROM _prisma_migrations WHERE rolled_back_at IS NULL`
          );
          const total = migrations.length;
          if (applied[0].cnt === total) {
            pass('All migrations applied', `${applied[0].cnt}/${total}`);
          } else {
            fail('Migrations not fully applied', `${applied[0].cnt}/${total} applied`);
          }
        } else {
          fail('_prisma_migrations table missing — run prisma migrate dev first');
        }
      } catch (e) {
        fail('Cannot check migration status', e.message);
      }
    } else {
      fail('No Prisma migrations found');
    }
  } else {
    pass('No prisma/migrations directory (may be managed externally)');
  }

  // ── 7. Backup Check ──
  console.log('\n── 7. Data Backup ──');
  try {
    const userCount = await prisma.user.count();
    if (userCount > 0) {
      // Check for backup markers
      const hasBackup = fs.existsSync(require('path').join(__dirname, '..', '.backup-verified'));
      if (hasBackup) {
        pass('Backup verified', `${userCount} users in database`);
      } else {
        fail('Backup not verified', `${userCount} users exist — create .backup-verified after confirming backup`);
      }
    } else {
      pass('Empty database — no backup needed');
    }
  } catch (e) {
    fail('Backup check', e.message);
  }

  // ── 8. Migration Manifest ──
  console.log('\n\n── Migration Manifest (Expected Counts) ──');
  try {
    const manifest = {
      Users: { total: await prisma.user.count({ where: { deletedAt: null } }) },
      Courses: { total: await prisma.course.count({ where: { deletedAt: null } }) },
      Lessons: { total: await prisma.lesson.count({ where: { deletedAt: null } }) },
      Reviews: { total: await prisma.review.count({ where: { deletedAt: null } }) },
      Subscriptions: { total: await prisma.subscription.count({ where: { deletedAt: null } }) },
      '→ Units': { expected: 'from Course.sections[]' },
      '→ Videos': { expected: 'from Lesson.videos[]' },
      '→ LessonFiles': { expected: 'from Lesson.pdfFiles[]' },
      '→ Quizzes': { expected: 'from Course/Lesson/Review.quiz' },
      '→ Questions': { expected: 'from each Quiz.questions[]' },
      '→ Choices': { expected: 'from each Question.choices[]' },
      '→ LessonProgress': { expected: 'from User.progress[].lessons[]' },
      '→ UserSubscriptions': { expected: `from User.subscriptionStatus/Start/End/planName/planPeriod` },
      '→ Referrals': { expected: 'from User.referredBy + User.referrals[]' },
      '→ ChildRelations': { expected: 'from User.childrenIds[] + User.parentOf[]' },
      '→ SubscriptionFeatures': { expected: 'from Subscription.features[]' },
      '→ ReviewVideos': { expected: 'from Review.videos[]' },
      '→ ReviewFiles': { expected: 'from Review.pdfFiles[]' },
    };

    // Calculate expected counts where possible
    const coursesWithSections = await prisma.course.count({
      where: { deletedAt: null, sections: { not: { _eq: '[]' } } },
    });
    const lessonsWithVideos = await prisma.lesson.count({
      where: { deletedAt: null, videos: { not: { _eq: '[]' } } },
    });
    const lessonsWithPdf = await prisma.lesson.count({
      where: { deletedAt: null, pdfFiles: { not: { _eq: '[]' } } },
    });
    const usersWithProgress = await prisma.user.count({
      where: { deletedAt: null, progress: { not: { _eq: '{}' } } },
    });
    const usersActiveSub = await prisma.user.count({
      where: { deletedAt: null, subscriptionStatus: { not: 'inactive' } },
    });
    const usersWithReferral = await prisma.user.count({
      where: { deletedAt: null, referredBy: { not: null } },
    });
    const usersWithChildren = await prisma.user.count({
      where: { deletedAt: null, childrenIds: { not: { _eq: '[]' } } },
    });
    const reviewsWithVideos = await prisma.review.count({
      where: { deletedAt: null, videos: { not: { _eq: '[]' } } },
    });
    const reviewsWithPdf = await prisma.review.count({
      where: { deletedAt: null, pdfFiles: { not: { _eq: '[]' } } },
    });
    const coursesWithQuiz = await prisma.course.count({
      where: { deletedAt: null, quiz: { not: null } },
    });
    const lessonsWithQuiz = await prisma.lesson.count({
      where: { deletedAt: null, quiz: { not: null } },
    });
    const reviewsWithQuiz = await prisma.review.count({
      where: { deletedAt: null, quiz: { not: null } },
    });
    const subsWithFeatures = await prisma.subscription.count({
      where: { deletedAt: null, features: { not: { _eq: '[]' } } },
    });

    const maxKey = Math.max(...Object.keys(manifest).map(k => k.length));
    for (const [key, val] of Object.entries(manifest)) {
      const label = key.padEnd(maxKey);
      if (val.total !== undefined) {
        console.log(`  ${label}  ${val.total}`);
      } else {
        console.log(`  ${label}  ${val.expected}`);
      }
    }

    // Additional source data details
    console.log('');
    console.log('  ── Detail ──');
    console.log(`  Courses with sections:         ${coursesWithSections}`);
    console.log(`  Lessons with videos:           ${lessonsWithVideos}`);
    console.log(`  Lessons with PDF files:        ${lessonsWithPdf}`);
    console.log(`  Users with progress:           ${usersWithProgress}`);
    console.log(`  Users with active subscription:${usersActiveSub}`);
    console.log(`  Users with referral:           ${usersWithReferral}`);
    console.log(`  Users with children:           ${usersWithChildren}`);
    console.log(`  Reviews with videos:           ${reviewsWithVideos}`);
    console.log(`  Reviews with PDF files:        ${reviewsWithPdf}`);
    console.log(`  Courses with quiz:             ${coursesWithQuiz}`);
    console.log(`  Lessons with quiz:             ${lessonsWithQuiz}`);
    console.log(`  Reviews with quiz:             ${reviewsWithQuiz}`);
    console.log(`  Subscriptions with features:   ${subsWithFeatures}`);
  } catch (e) {
    fail('Manifest', e.message);
  }

  // ── Final Result ──
  console.log('\n══════════════════════════════════════════════════');
  if (exitCode === 0) {
    console.log('  ✅ PREFLIGHT PASSED — All checks successful');
    console.log('  Ready for migration.');
  } else {
    console.log('  ❌ PREFLIGHT FAILED — Fix errors above before proceeding');
  }
  console.log('══════════════════════════════════════════════════\n');

  await disconnectPrisma();
  process.exit(exitCode);
}

main().catch(e => {
  console.error('\n❌ Preflight failed:', e);
  process.exit(1);
});
