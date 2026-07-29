#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { getPrisma, disconnectPrisma } = require('../src/database');

const CHECKPOINT_PATH = path.join(__dirname, '..', '.migration-checkpoint.json');

const prisma = getPrisma();

async function verify(quiet = false) {
  const result = { passed: true, failures: [] };

  if (!quiet) {
    console.log('══════════════════════════════════════════════════');
    console.log('  Phase 3 — Migration Verification Report');
    console.log(`  ${new Date().toISOString()}`);
    console.log('══════════════════════════════════════════════════\n');
  }

  // Check checkpoint
  const hasCheckpoint = fs.existsSync(CHECKPOINT_PATH);
  if (!quiet) {
    console.log(`Checkpoint: ${hasCheckpoint ? '✅ Found' : '⬜ None'}`);
  }
  if (hasCheckpoint && !quiet) {
    try {
      const cp = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
      console.log(`  Completed: ${(cp.completed || []).length} entities`);
      console.log(`  Updated: ${cp.updatedAt || 'unknown'}`);
      if (cp.completed) console.log(`  Entities: ${cp.completed.join(', ')}`);
    } catch { console.log('  (corrupted)'); }
  }

  try {
    await prisma.$connect();
    if (!quiet) console.log('\n  Database connected ✓\n');
  } catch (e) {
    const msg = 'Database connection FAILED: ' + e.message;
    if (!quiet) console.error('  ' + msg);
    result.passed = false;
    result.failures.push(msg);
    return result;
  }

  // ── Source Data (Legacy JSON fields) ──
  if (!quiet) console.log('── Source Data (Legacy JSON) ──');
  const src = {
    courses_total: await prisma.course.count({ where: { deletedAt: null } }),
    courses_with_sections: await prisma.course.count({ where: { deletedAt: null, sections: { not: { _eq: '[]' } } } }),
    courses_with_quiz: await prisma.course.count({ where: { deletedAt: null, quiz: { not: null } } }),
    lessons_total: await prisma.lesson.count({ where: { deletedAt: null } }),
    lessons_with_videos: await prisma.lesson.count({ where: { deletedAt: null, videos: { not: { _eq: '[]' } } } }),
    lessons_with_pdf: await prisma.lesson.count({ where: { deletedAt: null, pdfFiles: { not: { _eq: '[]' } } } }),
    lessons_with_quiz: await prisma.lesson.count({ where: { deletedAt: null, quiz: { not: null } } }),
    reviews_total: await prisma.review.count({ where: { deletedAt: null } }),
    reviews_with_videos: await prisma.review.count({ where: { deletedAt: null, videos: { not: { _eq: '[]' } } } }),
    reviews_with_pdf: await prisma.review.count({ where: { deletedAt: null, pdfFiles: { not: { _eq: '[]' } } } }),
    reviews_with_quiz: await prisma.review.count({ where: { deletedAt: null, quiz: { not: null } } }),
    users_total: await prisma.user.count({ where: { deletedAt: null } }),
    users_with_progress: await prisma.user.count({ where: { deletedAt: null, progress: { not: { _eq: '{}' } } } }),
    users_active_sub: await prisma.user.count({ where: { deletedAt: null, subscriptionStatus: { not: 'inactive' } } }),
    users_with_referral: await prisma.user.count({ where: { deletedAt: null, referredBy: { not: null } } }),
    users_with_children: await prisma.user.count({ where: { deletedAt: null, childrenIds: { not: { _eq: '[]' } } } }),
    subscriptions_total: await prisma.subscription.count({ where: { deletedAt: null } }),
    subscriptions_with_features: await prisma.subscription.count({ where: { deletedAt: null, features: { not: { _eq: '[]' } } } }),
  };

  if (!quiet) {
    const maxLen = Math.max(...Object.keys(src).map(k => k.length));
    for (const [key, val] of Object.entries(src)) {
      console.log(`  ${key.padEnd(maxLen)}  ${val}`);
    }
  }

  // ── Target Data (Normalized tables) ──
  if (!quiet) console.log('\n── Target Data (Normalized Tables) ──');
  const tgt = {
    units: await prisma.unit.count(),
    videos: await prisma.video.count(),
    lessonFiles: await prisma.lessonFile.count(),
    quizzes: await prisma.quiz.count(),
    questions: await prisma.question.count(),
    choices: await prisma.choice.count(),
    lessonProgress: await prisma.lessonProgress.count(),
    userSubscriptions: await prisma.userSubscription.count(),
    referrals: await prisma.referral.count(),
    childRelations: await prisma.childRelation.count(),
    subscriptionFeatures: await prisma.subscriptionFeature.count(),
    reviewVideos: await prisma.reviewVideo.count(),
    reviewFiles: await prisma.reviewFile.count(),
  };

  if (!quiet) {
    const maxLen2 = Math.max(...Object.keys(tgt).map(k => k.length));
    for (const [key, val] of Object.entries(tgt)) {
      console.log(`  ${key.padEnd(maxLen2)}  ${val}`);
    }
  }

  // ── Legacy Data Integrity Check ──
  if (!quiet) console.log('\n── Legacy Data Integrity ──');
  let allIntact = true;
  const checks = [
    ['Course.sections', src.courses_with_sections, 'sections JSON intact'],
    ['Lesson.videos', src.lessons_with_videos, 'videos JSON intact'],
    ['Lesson.pdfFiles', src.lessons_with_pdf, 'pdfFiles JSON intact'],
    ['User.progress', src.users_with_progress, 'progress JSON intact'],
    ['User.subscriptionStatus', src.users_active_sub, 'subscription fields intact'],
    ['User.referredBy', src.users_with_referral, 'referral fields intact'],
    ['User.childrenIds', src.users_with_children, 'children JSON intact'],
    ['Subscription.features', src.subscriptions_with_features, 'features JSON intact'],
  ];

  for (const [label, count, note] of checks) {
    const ok = count > 0;
    if (!ok) { allIntact = false; result.failures.push(`${label} is empty`); }
    if (!quiet) {
      const status = ok ? '✅' : '⬜';
      console.log(`  ${status} ${label.padEnd(30)} ${String(count).padStart(6)}  — ${note}`);
    }
  }

  if (!allIntact) result.passed = false;

  // ── New Data Sanity Checks ──
  if (!quiet) console.log('\n── New Data Sanity Checks ──');
  const migrationsRun = tgt.units > 0 || tgt.videos > 0 || tgt.quizzes > 0;

  if (migrationsRun) {
    if (!quiet) {
      if (tgt.units > 0) console.log('  ✅ Units: created');
      if (tgt.videos > 0) console.log('  ✅ Videos: normalized');
      if (tgt.lessonFiles > 0) console.log('  ✅ LessonFiles: normalized');
      if (tgt.quizzes > 0) console.log('  ✅ Quizzes: extracted');
      if (tgt.questions > 0) console.log('  ✅ Questions: extracted');
      if (tgt.choices > 0) console.log('  ✅ Choices: extracted');
    }

    // Relationship (orphan) checks
    const orphanChecks = [
      {
        name: 'Questions linked to quizzes',
        count: await prisma.question.count({
          where: { quizId: { notIn: (await prisma.quiz.findMany({ select: { id: true } })).map(q => q.id) } },
        }),
      },
      {
        name: 'Choices linked to questions',
        count: await prisma.choice.count({
          where: { questionId: { notIn: (await prisma.question.findMany({ select: { id: true } })).map(q => q.id) } },
        }),
      },
      {
        name: 'Progress linked to lessons',
        count: tgt.lessonProgress > 0 ? await prisma.lessonProgress.count({
          where: { lessonId: { notIn: (await prisma.lesson.findMany({ select: { id: true } })).map(l => l.id) } },
        }) : 0,
      },
      {
        name: 'Subscriptions linked to users',
        count: tgt.userSubscriptions > 0 ? await prisma.userSubscription.count({
          where: { userId: { notIn: (await prisma.user.findMany({ select: { id: true } })).map(u => u.id) } },
        }) : 0,
      },
      {
        name: 'Referrals linked to users',
        count: tgt.referrals > 0 ? await prisma.referral.count({
          where: {
            OR: [
              { referrerId: { notIn: (await prisma.user.findMany({ select: { id: true } })).map(u => u.id) } },
              { referredId: { notIn: (await prisma.user.findMany({ select: { id: true } })).map(u => u.id) } },
            ],
          },
        }) : 0,
      },
      {
        name: 'Child relations linked to users',
        count: tgt.childRelations > 0 ? await prisma.childRelation.count({
          where: {
            OR: [
              { parentId: { notIn: (await prisma.user.findMany({ select: { id: true } })).map(u => u.id) } },
              { childId: { notIn: (await prisma.user.findMany({ select: { id: true } })).map(u => u.id) } },
            ],
          },
        }) : 0,
      },
      {
        name: 'Features linked to plans',
        count: tgt.subscriptionFeatures > 0 ? await prisma.subscriptionFeature.count({
          where: { planId: { notIn: (await prisma.subscription.findMany({ select: { id: true } })).map(s => s.id) } },
        }) : 0,
      },
      {
        name: 'Review videos linked to reviews',
        count: tgt.reviewVideos > 0 ? await prisma.reviewVideo.count({
          where: { reviewId: { notIn: (await prisma.review.findMany({ select: { id: true } })).map(r => r.id) } },
        }) : 0,
      },
      {
        name: 'Review files linked to reviews',
        count: tgt.reviewFiles > 0 ? await prisma.reviewFile.count({
          where: { reviewId: { notIn: (await prisma.review.findMany({ select: { id: true } })).map(r => r.id) } },
        }) : 0,
      },
    ];

    for (const orphan of orphanChecks) {
      if (orphan.count === 0) {
        if (!quiet) console.log(`  ✅ ${orphan.name}`);
      } else {
        if (!quiet) console.log(`  ❌ ${orphan.count} orphan records: ${orphan.name}`);
        result.failures.push(`${orphan.count} orphan ${orphan.name}`);
        result.passed = false;
      }
    }
  } else {
    if (!quiet) console.log('  ⬜ No migration data found — migration not yet run');
    result.passed = false;
    result.failures.push('No migration data found');
  }

  // ── Summary ──
  if (!quiet) {
    console.log('\n══════════════════════════════════════════════════');
    console.log('  Verification Complete');
    console.log(`  Source metrics:   ${Object.keys(src).length}`);
    console.log(`  Target tables:    ${Object.keys(tgt).length}`);
    console.log(`  Legacy integrity: ${allIntact ? '✅ ALL INTACT' : '⚠️ SOME EMPTY (may be expected)'}`);
    console.log(`  Orphan records:   ${result.failures.length > 0 ? '❌ ' + result.failures.length + ' issue(s)' : '✅ NONE'}`);
    console.log(`  Migration status: ${migrationsRun ? '✅ DATA MIGRATED' : '⬜ NOT YET RUN'}`);
    console.log(`  Overall:          ${result.passed ? '✅ PASSED' : '❌ FAILED'}`);
    console.log('══════════════════════════════════════════════════\n');
  }

  await disconnectPrisma();
  return result;
}

// Run directly
if (require.main === module) {
  verify().catch(e => {
    console.error('Verification failed:', e);
    process.exit(1);
  });
}

module.exports = { verify };
