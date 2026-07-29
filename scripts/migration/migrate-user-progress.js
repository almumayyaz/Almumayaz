const { getClient } = require('./client');
const { resolveId } = require('./id-mapping');
const { readUsers } = require('./legacy-reader');
const { safeDate, safeString, newCuid, safeBoolean } = require('./utils');
const MigrationLogger = require('./logger');

async function migrateUserProgress({ dryRun = false } = {}) {
  const prisma = getClient();
  const logger = new MigrationLogger(dryRun);

  const legacy = readUsers();
  let lpCount = 0;
  let vpCount = 0;

  for (const u of legacy) {
    if (!u.progress) continue;
    for (const [courseId, cp] of Object.entries(u.progress)) {
      if (!cp || !cp.completedLessons || !Array.isArray(cp.completedLessons)) continue;
      lpCount += cp.completedLessons.length;
    }
  }

  if (dryRun) {
    logger.start('LessonProgress');
    logger.read('LessonProgress', lpCount);
    logger.done('LessonProgress', 0, lpCount);
    logger.start('VideoProgress');
    logger.read('VideoProgress', 0);
    logger.done('VideoProgress', 0, 0);
    return logger.report();
  }

  logger.start('LessonProgress');
  logger.start('VideoProgress');
  logger.read('LessonProgress', lpCount);
  logger.read('VideoProgress', 0);

  let lpCreated = 0;
  let lpSkipped = 0;
  const processedKeys = new Set();

  for (const u of legacy) {
    if (!u.progress) continue;
    const userId = await resolveId('User', u.id);
    if (!userId) {
      for (const [courseId, cp] of Object.entries(u.progress)) {
        if (cp && Array.isArray(cp.completedLessons)) {
          for (const lid of cp.completedLessons) {
            logger.logSkipped('LessonProgress', `${u.id}:${lid}`, 'user not in IdMapping');
            lpSkipped++;
          }
        }
      }
      continue;
    }

    for (const [legacyCourseId, cp] of Object.entries(u.progress)) {
      if (!cp || !Array.isArray(cp.completedLessons)) continue;

      for (const legacyLessonId of cp.completedLessons) {
        if (!legacyLessonId) {
          lpSkipped++;
          continue;
        }

        const key = `${userId}:${legacyLessonId}`;
        if (processedKeys.has(key)) continue;
        processedKeys.add(key);

        const lessonId = await resolveId('Lesson', legacyLessonId);
        if (!lessonId) {
          logger.logSkipped('LessonProgress', `${u.id}:${legacyLessonId}`, 'lesson not in IdMapping');
          lpSkipped++;
          continue;
        }

        try {
          const existing = await prisma.lessonProgress.findUnique({
            where: { studentId_lessonId: { studentId: userId, lessonId } },
          });
          if (existing) {
            lpSkipped++;
            continue;
          }

          if (dryRun) { lpCreated++; continue; }

          await prisma.lessonProgress.create({
            data: {
              id: newCuid(),
              studentId: userId,
              lessonId,
              completed: true,
              completedAt: null,
              watchTime: 0,
              lastAccess: new Date(),
            },
          });
          logger.logCreated('LessonProgress', `${u.id}:${legacyLessonId}`, lessonId);
          lpCreated++;
        } catch (e) {
          logger.logFailed('LessonProgress', `${u.id}:${legacyLessonId}`, e);
        }
      }
    }
  }

  logger.found('LessonProgress', lpCount);
  logger.done('LessonProgress', lpCreated, lpSkipped);
  logger.found('VideoProgress', 0);
  logger.done('VideoProgress', 0, 0);

  const dbLp = await prisma.lessonProgress.count();
  const dbVp = await prisma.videoProgress.count();

  return {
    report: logger.report(),
    summary: logger.summary(),
    legacyLp: lpCount,
    dbLp,
    lpCreated,
    lpSkipped,
    legacyVp: 0,
    dbVp,
  };
}

function dryRunUserProgress() {
  return migrateUserProgress({ dryRun: true });
}

module.exports = { migrateUserProgress, dryRunUserProgress };
