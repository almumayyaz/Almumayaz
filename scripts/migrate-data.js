#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { getPrisma, disconnectPrisma } = require('../src/database');
const MigrationLogger = require('./migration-logger');

const CHECKPOINT_PATH = path.join(__dirname, '..', '.migration-checkpoint.json');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const prisma = getPrisma();
const log = new MigrationLogger(DRY_RUN);

// ── Helpers ──

function safeJson(val, fallback = null) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

function asArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') { try { return JSON.parse(val); } catch { return []; } }
  if (typeof val === 'object') return Object.values(val);
  return [];
}

function safeInt(val) {
  if (val === null || val === undefined) return null;
  const n = parseInt(val);
  return isNaN(n) ? null : n;
}

function now() { return new Date(); }

// ── Mapping Tables (in-memory, persisted via checkpoint) ──

const sectionToUnit = new Map();
const quizToQuiz = new Map();
const quizQuestions = new Map();
const questionToQuestion = new Map();

// ── Checkpoint Management ──

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_PATH)) {
      const data = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
      console.log(`  Checkpoint loaded: ${data.completed || 0} entities completed`);
      return data;
    }
  } catch (e) {
    console.log('  No valid checkpoint found, starting fresh');
  }
  return null;
}

function saveCheckpoint(completed, mappings) {
  if (DRY_RUN) return;
  const data = {
    completed,
    updatedAt: new Date().toISOString(),
    mappings: {
      sectionToUnit: Object.fromEntries(mappings.sectionToUnit),
      quizToQuiz: Object.fromEntries(mappings.quizToQuiz),
      quizQuestions: Object.fromEntries(
        [...mappings.quizQuestions.entries()].map(([k, v]) => [k, v])
      ),
      questionToQuestion: Object.fromEntries(mappings.questionToQuestion),
    },
  };
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(data, null, 2));
}

function restoreMappingsFromCheckpoint(checkpoint) {
  if (!checkpoint || !checkpoint.mappings) return;
  const m = checkpoint.mappings;
  if (m.sectionToUnit) Object.entries(m.sectionToUnit).forEach(([k, v]) => sectionToUnit.set(k, v));
  if (m.quizToQuiz) Object.entries(m.quizToQuiz).forEach(([k, v]) => quizToQuiz.set(k, v));
  if (m.quizQuestions) Object.entries(m.quizQuestions).forEach(([k, v]) => quizQuestions.set(k, v));
  if (m.questionToQuestion) Object.entries(m.questionToQuestion).forEach(([k, v]) => questionToQuestion.set(k, v));
}

// ═══════════════════════════════════════════════════════════════
// 1. UNITS — from Course.sections[]
// ═══════════════════════════════════════════════════════════════

async function migrateUnits() {
  log.start('Units');
  try {
    const courses = await prisma.course.findMany({
      where: { deletedAt: null },
      select: { id: true, sections: true },
    });

    let created = 0, skipped = 0;
    let totalSections = 0;

    for (const course of courses) {
      const sections = asArray(safeJson(course.sections, []));
      for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        if (!sec || !sec.id) continue;
        totalSections++;
      }
    }
    log.read('Units', courses.length);
    log.found('Units', totalSections);

    // Process in batches of 50 courses per transaction
    const BATCH = 50;
    for (let batchStart = 0; batchStart < courses.length; batchStart += BATCH) {
      const batch = courses.slice(batchStart, batchStart + BATCH);
      await prisma.$transaction(async (tx) => {
        for (const course of batch) {
          const sections = asArray(safeJson(course.sections, []));
          for (let i = 0; i < sections.length; i++) {
            const sec = sections[i];
            if (!sec || !sec.id) continue;

            // Idempotency: check by (courseId, title) — stable key
            const existing = await tx.unit.findFirst({
              where: { courseId: course.id, title: sec.name || '' },
            });
            if (existing) {
              if (!sectionToUnit.has(sec.id)) sectionToUnit.set(sec.id, existing.id);
              skipped++;
              continue;
            }

            if (!DRY_RUN) {
              const unit = await tx.unit.create({
                data: {
                  courseId: course.id,
                  title: sec.name || 'فرع',
                  order: i,
                  description: '',
                },
              });
              sectionToUnit.set(sec.id, unit.id);
            }
            created++;
          }
        }
      });
      log.batch('Units', Math.min(batchStart + BATCH, courses.length), courses.length);
    }

    log.done('Units', created, skipped);
  } catch (e) {
    log.failure('Units', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// 2. VIDEOS — from Lesson.videos[]
// ═══════════════════════════════════════════════════════════════

async function migrateVideos() {
  log.start('Videos');
  try {
    const lessons = await prisma.lesson.findMany({
      where: { deletedAt: null },
      select: { id: true, videos: true },
    });

    log.read('Videos', lessons.length);
    let created = 0, skipped = 0;
    let total = 0;
    for (const l of lessons) total += asArray(safeJson(l.videos, [])).filter(v => v && v.url).length;
    log.found('Videos', total);

    const BATCH = 100;
    for (let b = 0; b < lessons.length; b += BATCH) {
      const batch = lessons.slice(b, b + BATCH);
      await prisma.$transaction(async (tx) => {
        for (const lesson of batch) {
          const vids = asArray(safeJson(lesson.videos, []));
          for (let i = 0; i < vids.length; i++) {
            const v = vids[i];
            if (!v || !v.url) continue;

            const existing = await tx.video.findFirst({
              where: { lessonId: lesson.id, url: v.url },
            });
            if (existing) { skipped++; continue; }

            if (!DRY_RUN) {
              await tx.video.create({
                data: {
                  lessonId: lesson.id,
                  order: v.order !== undefined ? v.order : i,
                  title: v.title || '',
                  url: v.url,
                  duration: safeInt(v.duration),
                  thumbnail: v.thumbnail || null,
                  isPreview: v.isPreview || false,
                },
              });
            }
            created++;
          }
        }
      });
      log.batch('Videos', Math.min(b + BATCH, lessons.length), lessons.length);
    }

    log.done('Videos', created, skipped);
  } catch (e) {
    log.failure('Videos', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// 3. LESSON FILES — from Lesson.pdfFiles[]
// ═══════════════════════════════════════════════════════════════

async function migrateLessonFiles() {
  log.start('LessonFiles');
  try {
    const lessons = await prisma.lesson.findMany({
      where: { deletedAt: null },
      select: { id: true, pdfFiles: true },
    });

    log.read('LessonFiles', lessons.length);
    let created = 0, skipped = 0;
    let total = 0;
    for (const l of lessons) total += asArray(safeJson(l.pdfFiles, [])).filter(f => f && f.url).length;
    log.found('LessonFiles', total);

    const BATCH = 100;
    for (let b = 0; b < lessons.length; b += BATCH) {
      const batch = lessons.slice(b, b + BATCH);
      await prisma.$transaction(async (tx) => {
        for (const lesson of batch) {
          const files = asArray(safeJson(lesson.pdfFiles, []));
          for (let i = 0; i < files.length; i++) {
            const f = files[i];
            if (!f || !f.url) continue;

            const existing = await tx.lessonFile.findFirst({
              where: { lessonId: lesson.id, url: f.url },
            });
            if (existing) { skipped++; continue; }

            if (!DRY_RUN) {
              await tx.lessonFile.create({
                data: {
                  lessonId: lesson.id,
                  order: f.order !== undefined ? f.order : i,
                  title: f.title || '',
                  url: f.url,
                  filePath: f.filePath || '',
                  type: f.type || 'pdf',
                  size: safeInt(f.size),
                },
              });
            }
            created++;
          }
        }
      });
      log.batch('LessonFiles', Math.min(b + BATCH, lessons.length), lessons.length);
    }

    log.done('LessonFiles', created, skipped);
  } catch (e) {
    log.failure('LessonFiles', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// 4. QUIZZES — from Course.quiz / Lesson.quiz / Review.quiz
// ═══════════════════════════════════════════════════════════════

async function migrateQuizzes() {
  log.start('Quizzes');
  try {
    let created = 0, skipped = 0;

    function normalizeQuestions(rawQuestions) {
      return Array.isArray(rawQuestions) ? rawQuestions : asArray(rawQuestions);
    }

    async function processQuiz(tx, entityType, entityId, quizJson) {
      if (!quizJson) return;
      const quiz = safeJson(quizJson);
      if (!quiz || !quiz.questions) return;
      const key = entityType + ':' + entityId;
      const questionsList = normalizeQuestions(quiz.questions);

      const existingQuiz = await tx.quiz.findFirst({
        where: { entityType, entityId },
      });
      if (existingQuiz) {
        if (!quizToQuiz.has(key)) quizToQuiz.set(key, existingQuiz.id);
        quizQuestions.set(existingQuiz.id, questionsList);
        skipped++;
        return;
      }

      // Handle passPercentage===0 as valid value
      const passPct = quiz.passPercentage !== undefined ? quiz.passPercentage : quiz.passScore;
      if (!DRY_RUN) {
        const createdQuiz = await tx.quiz.create({
          data: {
            entityType,
            entityId,
            title: quiz.title || 'اختبار',
            passPercentage: typeof passPct === 'number' ? passPct : safeInt(passPct) || 60,
            timerMinutes: safeInt(quiz.timerMinutes),
            shuffleQuestions: quiz.shuffleQuestions || false,
            maxAttempts: safeInt(quiz.maxAttempts),
          },
        });
        quizToQuiz.set(key, createdQuiz.id);
        quizQuestions.set(createdQuiz.id, questionsList);
      } else {
        quizToQuiz.set(key, `${entityType}:${entityId}`);
      }
      created++;
    }

    let coursesWithQuiz = 0, lessonsWithQuiz = 0, reviewsWithQuiz = 0;
    await prisma.$transaction(async (tx) => {
      const courses = await prisma.course.findMany({
        where: { deletedAt: null, quiz: { not: null } },
        select: { id: true, quiz: true },
      });
      coursesWithQuiz = courses.length;
      for (const c of courses) await processQuiz(tx, 'course', c.id, c.quiz);

      const lessons = await prisma.lesson.findMany({
        where: { deletedAt: null, quiz: { not: null } },
        select: { id: true, quiz: true },
      });
      lessonsWithQuiz = lessons.length;
      for (const l of lessons) await processQuiz(tx, 'lesson', l.id, l.quiz);

      const reviews = await prisma.review.findMany({
        where: { deletedAt: null, quiz: { not: null } },
        select: { id: true, quiz: true },
      });
      reviewsWithQuiz = reviews.length;
      for (const r of reviews) await processQuiz(tx, 'review', r.id, r.quiz);
    });
    log.read('Quizzes', coursesWithQuiz + lessonsWithQuiz + reviewsWithQuiz);

    log.done('Quizzes', created, skipped);
  } catch (e) {
    log.failure('Quizzes', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// 5. QUESTIONS — from Quiz.questions[]
// ═══════════════════════════════════════════════════════════════

async function migrateQuestions() {
  log.start('Questions');
  try {
    const quizIds = [...quizQuestions.keys()];
    if (quizIds.length === 0) {
      log.found('Questions', 0);
      log.done('Questions', 0, 0);
      return;
    }

    let created = 0, skipped = 0;
    let total = 0;
    for (const qid of quizIds) total += (quizQuestions.get(qid) || []).length;
    log.found('Questions', total);

    // Batch per quiz — each quiz's questions in one transaction
    for (let i = 0; i < quizIds.length; i++) {
      const quizId = quizIds[i];
      const questions = quizQuestions.get(quizId) || [];
      const batchQuestions = [];

      for (let j = 0; j < questions.length; j++) {
        const q = questions[j];
        if (!q || !q.text) continue;
        const key = quizId + '_' + j;

        const existing = await prisma.question.findFirst({
          where: { quizId, text: q.text, order: j },
        });
        if (existing) {
          if (!questionToQuestion.has(key)) questionToQuestion.set(key, existing.id);
          skipped++;
          continue;
        }
        batchQuestions.push({ q, j, key });
      }

      if (batchQuestions.length === 0) continue;

      await prisma.$transaction(async (tx) => {
        for (const { q, j, key } of batchQuestions) {
          if (DRY_RUN) {
            questionToQuestion.set(key, `${quizId}_${j}`);
            created++;
            continue;
          }
          const question = await tx.question.create({
            data: {
              quizId,
              type: q.type || 'single_choice',
              text: q.text,
              image: q.image || null,
              explanation: q.explanation || null,
              points: safeInt(q.points) || 1,
              order: j,
            },
          });
          questionToQuestion.set(key, question.id);
          created++;
        }
      });

      log.batch('Questions', i + 1, quizIds.length);
    }

    log.done('Questions', created, skipped);
  } catch (e) {
    log.failure('Questions', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// 6. CHOICES — from Question JSON choices[]
// ═══════════════════════════════════════════════════════════════

async function migrateChoices() {
  log.start('Choices');
  try {
    let created = 0, skipped = 0;

    // Read all quizzes with their questions from DB
    const quizzes = await prisma.quiz.findMany({
      include: { questions: { orderBy: { order: 'asc' } } },
    });

    let total = 0;
    for (const quiz of quizzes) {
      const rawQuestions = quizQuestions.get(quiz.id) || [];
      for (let i = 0; i < quiz.questions.length; i++) {
        const rawQ = rawQuestions[i] || {};
        total += asArray(rawQ.choices || rawQ.options || []).filter(c => c && c.text).length;
      }
    }
    log.found('Choices', total);

    for (const quiz of quizzes) {
      const rawQuestions = quizQuestions.get(quiz.id) || [];
      const choicesToCreate = [];

      for (let i = 0; i < quiz.questions.length; i++) {
        const question = quiz.questions[i];
        const rawQ = rawQuestions[i] || {};
        const choices = asArray(rawQ.choices || rawQ.options || []);

        for (let j = 0; j < choices.length; j++) {
          const c = choices[j];
          if (!c || !c.text) continue;

          const existing = await prisma.choice.findFirst({
            where: { questionId: question.id, text: c.text },
          });
          if (existing) { skipped++; continue; }

          choicesToCreate.push({
            questionId: question.id,
            text: c.text,
            isCorrect: c.isCorrect || c.correct || false,
            order: c.order !== undefined ? c.order : j,
          });
        }
      }

      if (choicesToCreate.length === 0) continue;

      if (!DRY_RUN) {
        await prisma.$transaction(async (tx) => {
          for (const data of choicesToCreate) {
            await tx.choice.create({ data });
          }
        });
      }
      created += choicesToCreate.length;
      log.batch('Choices', quizzes.indexOf(quiz) + 1, quizzes.length);
    }

    log.done('Choices', created, skipped);
  } catch (e) {
    log.failure('Choices', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// 7. LESSON PROGRESS — from User.progress[].lessons[]
// ═══════════════════════════════════════════════════════════════

async function migrateLessonProgress() {
  log.start('LessonProgress');
  try {
    const users = await prisma.user.findMany({
      where: { deletedAt: null },
      select: { id: true, progress: true },
    });

    // Pre-collect all referenced lesson IDs for batch existence check
    const allLessonIds = new Set();
    const userProgressMap = [];

    for (const user of users) {
      const progress = safeJson(user.progress, {});
      if (!progress) continue;
      for (const [courseId, cp] of Object.entries(progress)) {
        if (!cp || !cp.lessons) continue;
        for (const lessonId of Object.keys(cp.lessons)) {
          allLessonIds.add(lessonId);
          userProgressMap.push({ userId: user.id, courseId, lessonId, lp: cp.lessons[lessonId], completedLessons: cp.completedLessons || [] });
        }
      }
    }

    log.read('LessonProgress', users.length);
    log.found('LessonProgress', userProgressMap.length);

    // Batch-check which lessons exist (one query instead of N)
    const existingLessonIds = new Set();
    if (allLessonIds.size > 0) {
      const existingLessons = await prisma.lesson.findMany({
        where: { id: { in: [...allLessonIds] } },
        select: { id: true },
      });
      existingLessons.forEach(l => existingLessonIds.add(l.id));
    }

    let created = 0, skipped = 0, updated = 0;

    // Batch users in smaller chunks (200 users per transaction)
    const BATCH_SIZE = 200;

    for (let b = 0; b < userProgressMap.length; b += BATCH_SIZE) {
      const batch = userProgressMap.slice(b, b + BATCH_SIZE);

      await prisma.$transaction(async (tx) => {
        for (const item of batch) {
          if (!existingLessonIds.has(item.lessonId)) continue;

          // Check within transaction to avoid race conditions across batches
          const existing = await tx.lessonProgress.findUnique({
            where: { studentId_lessonId: { studentId: item.userId, lessonId: item.lessonId } },
          });
          if (existing) {
            skipped++;
            continue;
          }

          const completed = item.completedLessons.includes(item.lessonId);
          if (!DRY_RUN) {
            await tx.lessonProgress.create({
              data: {
                studentId: item.userId,
                lessonId: item.lessonId,
                completed: !!completed,
                completedAt: completed ? now() : null,
                watchTime: item.lp.watchTime || 0,
                lastAccess: now(),
              },
            });
          }
          created++;
        }
      });

      log.batch('LessonProgress', Math.min(b + BATCH_SIZE, userProgressMap.length), userProgressMap.length);
    }

    log.done('LessonProgress', created, skipped, updated);
  } catch (e) {
    log.failure('LessonProgress', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// 8. USER SUBSCRIPTIONS — from User legacy subscription fields
// ═══════════════════════════════════════════════════════════════

async function migrateUserSubscriptions() {
  log.start('UserSubscriptions');
  try {
    const users = await prisma.user.findMany({
      where: { deletedAt: null, subscriptionStatus: { not: 'inactive' } },
      select: {
        id: true, subscriptionStatus: true, subscriptionStart: true,
        subscriptionEnd: true, planName: true, planPeriod: true,
        subscribedStage: true, referralDiscount: true,
      },
    });
    log.read('UserSubscriptions', users.length);
    log.found('UserSubscriptions', users.length);

    let created = 0, skipped = 0;
    const BATCH = 100;

    for (let b = 0; b < users.length; b += BATCH) {
      const batch = users.slice(b, b + BATCH);
      await prisma.$transaction(async (tx) => {
        for (const user of batch) {
          if (!user.subscriptionStatus || user.subscriptionStatus === 'inactive') continue;
          const existing = await tx.userSubscription.findFirst({
            where: { userId: user.id, status: { in: ['active', 'cancelled', 'expired'] } },
            orderBy: { startDate: 'desc' },
          });
          if (existing) { skipped++; continue; }

          if (!DRY_RUN) {
            await tx.userSubscription.create({
              data: {
                userId: user.id,
                planName: user.planName || 'اشتراك',
                status: user.subscriptionStatus === 'cancelled' ? 'cancelled' : 'active',
                startDate: user.subscriptionStart || now(),
                endDate: user.subscriptionEnd || null,
                period: user.planPeriod || 'شهرياً',
                stage: user.subscribedStage || '',
                discount: user.referralDiscount || 0,
              },
            });
          }
          created++;
        }
      });
      log.batch('UserSubscriptions', Math.min(b + BATCH, users.length), users.length);
    }

    log.done('UserSubscriptions', created, skipped);
  } catch (e) {
    log.failure('UserSubscriptions', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// 9. REFERRALS — from User.referralCode + User.referrals[]
// ═══════════════════════════════════════════════════════════════

async function migrateReferrals() {
  log.start('Referrals');
  try {
    const users = await prisma.user.findMany({
      where: { deletedAt: null },
      select: { id: true, referralCode: true, referredBy: true, referralDiscount: true, referrals: true },
    });
    const totalOps = users.filter(u => u.referredBy).length +
      users.reduce((sum, u) => sum + asArray(safeJson(u.referrals, [])).length, 0);
    log.read('Referrals', users.length);
    log.found('Referrals', totalOps);

    let created = 0, skipped = 0;
    const BATCH = 100;

    for (let b = 0; b < users.length; b += BATCH) {
      const batch = users.slice(b, b + BATCH);
      await prisma.$transaction(async (tx) => {
        for (const user of batch) {
          if (user.referredBy) {
            const referrer = await tx.user.findFirst({
              where: { referralCode: user.referredBy },
              select: { id: true },
            });
            if (referrer && referrer.id !== user.id) {
              const existing = await tx.referral.findUnique({
                where: { referredId: user.id },
              });
              if (!existing) {
                if (!DRY_RUN) {
                  await tx.referral.create({
                    data: {
                      referrerId: referrer.id,
                      referredId: user.id,
                      discount: user.referralDiscount || 25,
                      code: user.referredBy,
                    },
                  });
                }
                created++;
              } else { skipped++; }
            }
          }

          const referralsArr = asArray(safeJson(user.referrals, []));
          for (const ref of referralsArr) {
            if (!ref || !ref.userId) continue;
            const existing = await tx.referral.findUnique({
              where: { referredId: ref.userId },
            });
            if (!existing) {
              const referredUser = await tx.user.findUnique({
                where: { id: ref.userId },
                select: { id: true },
              });
              if (referredUser && referredUser.id !== user.id) {
                if (!DRY_RUN) {
                  await tx.referral.create({
                    data: {
                      referrerId: user.id,
                      referredId: referredUser.id,
                      discount: ref.discount || user.referralDiscount || 25,
                      code: user.referralCode || '',
                    },
                  });
                }
                created++;
              }
            } else { skipped++; }
          }
        }
      });
      log.batch('Referrals', Math.min(b + BATCH, users.length), users.length);
    }

    log.done('Referrals', created, skipped);
  } catch (e) {
    log.failure('Referrals', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// 10. CHILD RELATIONS — from User.childrenIds[] + User.parentOf[]
// ═══════════════════════════════════════════════════════════════

async function migrateChildRelations() {
  log.start('ChildRelations');
  try {
    const users = await prisma.user.findMany({
      where: { deletedAt: null },
      select: { id: true, role: true, childrenIds: true, parentOf: true },
    });

    let total = 0;
    for (const u of users) {
      total += asArray(safeJson(u.childrenIds, [])).length;
      total += asArray(safeJson(u.parentOf, [])).length;
    }
    log.read('ChildRelations', users.length);
    log.found('ChildRelations', total);

    let created = 0, skipped = 0;
    const BATCH = 100;

    for (let b = 0; b < users.length; b += BATCH) {
      const batch = users.slice(b, b + BATCH);
      await prisma.$transaction(async (tx) => {
        for (const user of batch) {
          const childrenIds = asArray(safeJson(user.childrenIds, []));
          for (const childId of childrenIds) {
            if (!childId) continue;
            const child = await tx.user.findUnique({
              where: { id: childId },
              select: { id: true },
            });
            if (!child) continue;
            const existing = await tx.childRelation.findUnique({
              where: { parentId_childId: { parentId: user.id, childId } },
            });
            if (existing) { skipped++; continue; }
            if (!DRY_RUN) {
              await tx.childRelation.create({
                data: { parentId: user.id, childId },
              });
            }
            created++;
          }

          const parentOfNames = asArray(safeJson(user.parentOf, []));
          if (parentOfNames.length > 0) {
            const children = await tx.user.findMany({
              where: { parentId: user.id, deletedAt: null },
              select: { id: true },
            });
            for (const child of children) {
              const existing = await tx.childRelation.findUnique({
                where: { parentId_childId: { parentId: user.id, childId: child.id } },
              });
              if (existing) { skipped++; continue; }
              if (!DRY_RUN) {
                await tx.childRelation.create({
                  data: { parentId: user.id, childId: child.id },
                });
              }
              created++;
            }
          }
        }
      });
      log.batch('ChildRelations', Math.min(b + BATCH, users.length), users.length);
    }

    log.done('ChildRelations', created, skipped);
  } catch (e) {
    log.failure('ChildRelations', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// 11. SUBSCRIPTION FEATURES — from Subscription.features[]
// ═══════════════════════════════════════════════════════════════

async function migrateSubscriptionFeatures() {
  log.start('SubscriptionFeatures');
  try {
    const plans = await prisma.subscription.findMany({
      where: { deletedAt: null },
      select: { id: true, features: true },
    });

    log.read('SubscriptionFeatures', plans.length);
    let created = 0, skipped = 0;
    let total = 0;
    for (const p of plans) total += asArray(safeJson(p.features, [])).length;
    log.found('SubscriptionFeatures', total);

    const BATCH = 50;
    for (let b = 0; b < plans.length; b += BATCH) {
      const batch = plans.slice(b, b + BATCH);
      await prisma.$transaction(async (tx) => {
        for (const plan of batch) {
          const features = asArray(safeJson(plan.features, []));
          for (let i = 0; i < features.length; i++) {
            const text = features[i];
            if (!text) continue;
            const featureText = typeof text === 'string' ? text : (text.text || '');
            if (!featureText) continue;
            const existing = await tx.subscriptionFeature.findFirst({
              where: { planId: plan.id, text: featureText },
            });
            if (existing) { skipped++; continue; }
            if (!DRY_RUN) {
              await tx.subscriptionFeature.create({
                data: { planId: plan.id, text: featureText, order: i },
              });
            }
            created++;
          }
        }
      });
      log.batch('SubscriptionFeatures', Math.min(b + BATCH, plans.length), plans.length);
    }

    log.done('SubscriptionFeatures', created, skipped);
  } catch (e) {
    log.failure('SubscriptionFeatures', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// 12. REVIEW VIDEOS — from Review.videos[]
// ═══════════════════════════════════════════════════════════════

async function migrateReviewVideos() {
  log.start('ReviewVideos');
  try {
    const reviews = await prisma.review.findMany({
      where: { deletedAt: null },
      select: { id: true, videos: true },
    });

    log.read('ReviewVideos', reviews.length);
    let created = 0, skipped = 0;
    let total = 0;
    for (const r of reviews) total += asArray(safeJson(r.videos, [])).filter(v => v && v.url).length;
    log.found('ReviewVideos', total);

    const BATCH = 100;
    for (let b = 0; b < reviews.length; b += BATCH) {
      const batch = reviews.slice(b, b + BATCH);
      await prisma.$transaction(async (tx) => {
        for (const review of batch) {
          const vids = asArray(safeJson(review.videos, []));
          for (let i = 0; i < vids.length; i++) {
            const v = vids[i];
            if (!v || !v.url) continue;
            const existing = await tx.reviewVideo.findFirst({
              where: { reviewId: review.id, url: v.url },
            });
            if (existing) { skipped++; continue; }
            if (!DRY_RUN) {
              await tx.reviewVideo.create({
                data: {
                  reviewId: review.id,
                  order: v.order !== undefined ? v.order : i,
                  title: v.title || '',
                  url: v.url,
                  duration: safeInt(v.duration),
                },
              });
            }
            created++;
          }
        }
      });
      log.batch('ReviewVideos', Math.min(b + BATCH, reviews.length), reviews.length);
    }

    log.done('ReviewVideos', created, skipped);
  } catch (e) {
    log.failure('ReviewVideos', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// 13. REVIEW FILES — from Review.pdfFiles[]
// ═══════════════════════════════════════════════════════════════

async function migrateReviewFiles() {
  log.start('ReviewFiles');
  try {
    const reviews = await prisma.review.findMany({
      where: { deletedAt: null },
      select: { id: true, pdfFiles: true },
    });

    log.read('ReviewFiles', reviews.length);
    let created = 0, skipped = 0;
    let total = 0;
    for (const r of reviews) total += asArray(safeJson(r.pdfFiles, [])).filter(f => f && f.url).length;
    log.found('ReviewFiles', total);

    const BATCH = 100;
    for (let b = 0; b < reviews.length; b += BATCH) {
      const batch = reviews.slice(b, b + BATCH);
      await prisma.$transaction(async (tx) => {
        for (const review of batch) {
          const files = asArray(safeJson(review.pdfFiles, []));
          for (let i = 0; i < files.length; i++) {
            const f = files[i];
            if (!f || !f.url) continue;
            const existing = await tx.reviewFile.findFirst({
              where: { reviewId: review.id, url: f.url },
            });
            if (existing) { skipped++; continue; }
            if (!DRY_RUN) {
              await tx.reviewFile.create({
                data: {
                  reviewId: review.id,
                  order: f.order !== undefined ? f.order : i,
                  title: f.title || '',
                  url: f.url,
                  filePath: f.filePath || '',
                  type: f.type || 'pdf',
                  size: safeInt(f.size),
                },
              });
            }
            created++;
          }
        }
      });
      log.batch('ReviewFiles', Math.min(b + BATCH, reviews.length), reviews.length);
    }

    log.done('ReviewFiles', created, skipped);
  } catch (e) {
    log.failure('ReviewFiles', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Phase 3 — Data Migration');
  console.log(`  ${DRY_RUN ? '🔍 DRY RUN MODE — NO DATA WILL BE WRITTEN' : '🚀 LIVE MODE'}`);
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════\n');

  try {
    await prisma.$connect();
    console.log('  Database connected ✓\n');
  } catch (e) {
    console.error('  Database connection FAILED:', e.message);
    process.exit(1);
  }

  // ── Print Migration Manifest ──
  console.log('── Migration Manifest — Expected Source Counts ──');
  try {
    const manifest = {
      Users: await prisma.user.count({ where: { deletedAt: null } }),
      Courses: await prisma.course.count({ where: { deletedAt: null } }),
      Lessons: await prisma.lesson.count({ where: { deletedAt: null } }),
      Reviews: await prisma.review.count({ where: { deletedAt: null } }),
      'Courses with sections': await prisma.course.count({ where: { deletedAt: null, sections: { not: { _eq: '[]' } } } }),
      'Lessons with videos': await prisma.lesson.count({ where: { deletedAt: null, videos: { not: { _eq: '[]' } } } }),
      'Lessons with files': await prisma.lesson.count({ where: { deletedAt: null, pdfFiles: { not: { _eq: '[]' } } } }),
      'Users with progress': await prisma.user.count({ where: { deletedAt: null, progress: { not: { _eq: '{}' } } } }),
      'Users (active sub)': await prisma.user.count({ where: { deletedAt: null, subscriptionStatus: { not: 'inactive' } } }),
      'Users with referral': await prisma.user.count({ where: { deletedAt: null, referredBy: { not: null } } }),
      'Users with children': await prisma.user.count({ where: { deletedAt: null, childrenIds: { not: { _eq: '[]' } } } }),
      'Entities with quiz': await prisma.course.count({ where: { deletedAt: null, quiz: { not: null } } })
        + await prisma.lesson.count({ where: { deletedAt: null, quiz: { not: null } } })
        + await prisma.review.count({ where: { deletedAt: null, quiz: { not: null } } }),
      'Subs with features': await prisma.subscription.count({ where: { deletedAt: null, features: { not: { _eq: '[]' } } } }),
    };
    const maxKey = Math.max(...Object.keys(manifest).map(k => k.length));
    for (const [key, val] of Object.entries(manifest)) {
      console.log(`  ${key.padEnd(maxKey)}  ${val}`);
    }
  } catch (e) {
    console.log('  (manifest unavailable)');
  }

  // Load checkpoint for resume
  const checkpoint = loadCheckpoint();
  const completedEntities = new Set(checkpoint ? checkpoint.completed || [] : []);
  if (checkpoint) restoreMappingsFromCheckpoint(checkpoint);

  const entityList = [
    { name: 'Units', fn: migrateUnits },
    { name: 'Videos', fn: migrateVideos },
    { name: 'LessonFiles', fn: migrateLessonFiles },
    { name: 'Quizzes', fn: migrateQuizzes },
    { name: 'Questions', fn: migrateQuestions },
    { name: 'Choices', fn: migrateChoices },
    { name: 'LessonProgress', fn: migrateLessonProgress },
    { name: 'UserSubscriptions', fn: migrateUserSubscriptions },
    { name: 'Referrals', fn: migrateReferrals },
    { name: 'ChildRelations', fn: migrateChildRelations },
    { name: 'SubscriptionFeatures', fn: migrateSubscriptionFeatures },
    { name: 'ReviewVideos', fn: migrateReviewVideos },
    { name: 'ReviewFiles', fn: migrateReviewFiles },
  ];

  // In resume mode with --force, ignore checkpoint and run all
  const skipCompleted = !FORCE && !DRY_RUN;
  let allSucceeded = true;

  for (const entity of entityList) {
    if (skipCompleted && completedEntities.has(entity.name)) {
      console.log(`\n  [${entity.name}] Already completed (from checkpoint), skipping...`);
      // Restore mappings was done above from checkpoint
      continue;
    }
    await entity.fn();

    // Save checkpoint after each entity (unless dry run)
    if (!DRY_RUN) {
      completedEntities.add(entity.name);
      saveCheckpoint([...completedEntities], {
        sectionToUnit, quizToQuiz, quizQuestions, questionToQuestion,
      });
    }

    // Failure Policy: if the entity has errors, mark overall failure
    // but continue processing (report all failures)
    const entityEntry = log.logs.find(l => l.entity === entity.name);
    if (entityEntry && entityEntry.failed > 0) {
      allSucceeded = false;
      console.log(`\n  ⚠️  [${entity.name}] completed with ${entityEntry.failed} error(s)`);
    }
  }

  // Print summary
  const summary = log.summary();

  // Print mapping stats (only meaningful in live mode or after checkpoint restore)
  if (!DRY_RUN || checkpoint) {
    console.log('\n── Mapping Tables ──');
    console.log(`  Section → Unit:      ${sectionToUnit.size} mappings`);
    console.log(`  Entity → Quiz:       ${quizToQuiz.size} mappings`);
    console.log(`  Quiz+Idx → Question: ${questionToQuestion.size} mappings`);
  }

  // Legacy data integrity verification
  console.log('\n── Legacy Data Integrity ──');
  const intactChecks = [
    await prisma.course.count({ where: { deletedAt: null, sections: { not: { _eq: '[]' } } } }),
    await prisma.lesson.count({ where: { deletedAt: null, videos: { not: { _eq: '[]' } } } }),
    await prisma.lesson.count({ where: { deletedAt: null, pdfFiles: { not: { _eq: '[]' } } } }),
    await prisma.user.count({ where: { deletedAt: null, progress: { not: { _eq: '{}' } } } }),
    await prisma.user.count({ where: { deletedAt: null, subscriptionStatus: { not: 'inactive' } } }),
    await prisma.user.count({ where: { deletedAt: null, referredBy: { not: null } } }),
    await prisma.subscription.count({ where: { deletedAt: null, features: { not: { _eq: '[]' } } } }),
  ];
  const labels = [
    'Course.sections', 'Lesson.videos', 'Lesson.pdfFiles',
    'User.progress', 'User.subscriptionStatus (active)',
    'User.referredBy', 'Subscription.features',
  ];
  let allIntact = true;
  for (let i = 0; i < intactChecks.length; i++) {
    const ok = intactChecks[i] > 0;
    if (!ok) allIntact = false;
    console.log(`  ${ok ? '✅' : '⚠️'} ${labels[i]}: ${intactChecks[i]} records`);
  }
  console.log(`\n  Legacy integrity: ${allIntact ? '✅ ALL INTACT' : '⚠️ SOME EMPTY (may be expected)'}`);

  // ── Auto-run Verification (live mode only, not dry run) ──
  let verificationPassed = true;
  if (!DRY_RUN) {
    console.log('\n── Auto-Verification ──');
    try {
      const { verify } = require('./verify-migration');
      const vResult = await verify(true);
      verificationPassed = vResult.passed;
      console.log(`  Auto-verification: ${vResult.passed ? '✅ PASSED' : '❌ FAILED'}`);
      if (!vResult.passed) {
        console.log('  Failures:');
        for (const f of vResult.failures) console.log(`    - ${f}`);
      }
    } catch (e) {
      verificationPassed = false;
      console.log(`  Auto-verification FAILED: ${e.message}`);
    }
  }

  // ── Save Execution Log ──
  if (!DRY_RUN) {
    const reportsDir = path.join(__dirname, '..', 'migration-reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(reportsDir, `migration-${timestamp}.json`);
    const execLog = {
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      prismaVersion: require('@prisma/client/package.json').version,
      duration: summary.totalDuration,
      durationFormatted: (summary.totalDuration / 1000).toFixed(1) + 's',
      mode: DRY_RUN ? 'dry-run' : 'live',
      resume: !!checkpoint,
      force: FORCE,
      verificationPassed,
      allEntitiesSucceeded: allSucceeded,
      legacyIntegrity: allIntact,
      entities: log.report().entries,
      mappings: {
        sectionToUnit: sectionToUnit.size,
        quizToQuiz: quizToQuiz.size,
        questionToQuestion: questionToQuestion.size,
      },
      finalSummary: {
        totalCreated: summary.grandCreated,
        totalErrors: summary.grandErrors,
        totalDuration: summary.totalDuration,
      },
    };
    fs.writeFileSync(reportPath, JSON.stringify(execLog, null, 2));
    console.log(`\n  Execution log saved to: ${reportPath}`);
  }

  // In dry run, note that no data was written
  if (DRY_RUN) {
    console.log('\n  🔍 DRY RUN COMPLETE — no data was written to the database.');
    console.log('  Remove --dry-run to execute the actual migration.');
  }

  // Note about checkpoint
  if (!DRY_RUN) {
    console.log(`\n  Checkpoint saved to: ${CHECKPOINT_PATH}`);
    console.log('  Use --force to re-run all entities (ignore checkpoint).');
  }

  await disconnectPrisma();

  // Success Criteria Check
  const success = !DRY_RUN && allSucceeded && verificationPassed && allIntact;
  if (!DRY_RUN) {
    console.log('\n═══════════════════════════════════════════');
    if (success) {
      console.log('  ✅ PHASE 3 MIGRATION SUCCESSFUL');
      console.log('  All success criteria met:');
      console.log('    • All entities completed without errors');
      console.log('    • Verification checks passed');
      console.log('    • Legacy data intact');
      console.log('    • Checkpoint saved');
    } else {
      console.log('  ❌ PHASE 3 MIGRATION COMPLETED WITH ISSUES');
      if (!allSucceeded) console.log('    • Some entities reported errors');
      if (!verificationPassed) console.log('    • Verification checks failed');
      if (!allIntact) console.log('    • Some legacy fields appear empty');
    }
    console.log('═══════════════════════════════════════════\n');
  }

  process.exit(success || DRY_RUN ? 0 : 1);
}

main().catch((e) => {
  console.error('\n❌ Migration failed:', e);
  process.exit(1);
});
