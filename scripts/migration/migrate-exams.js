const { getClient } = require('./client');
const { resolveId } = require('./id-mapping');
const { readUsers } = require('./legacy-reader');
const { safeDate, safeNumber, safeString, newCuid } = require('./utils');
const MigrationLogger = require('./logger');

async function migrateExams({ dryRun = false } = {}) {
  const prisma = getClient();
  const logger = new MigrationLogger(dryRun);

  const legacy = readUsers();

  // Count exam results
  let examAttemptCount = 0;
  for (const u of legacy) {
    if (u.examResults) examAttemptCount += u.examResults.length;
    if (u.quizResults) {
      for (const cid of Object.keys(u.quizResults || {})) {
        examAttemptCount += Object.keys(u.quizResults[cid] || {}).length;
      }
    }
  }

  if (dryRun) {
    logger.start('ExamAttempt');
    logger.read('ExamAttempt', examAttemptCount);
    logger.done('ExamAttempt', 0, examAttemptCount);
    logger.start('ExamAnswer');
    logger.read('ExamAnswer', 0);
    logger.done('ExamAnswer', 0, 0);
    return logger.report();
  }

  logger.start('ExamAttempt');
  logger.start('ExamAnswer');
  logger.read('ExamAttempt', examAttemptCount);
  logger.read('ExamAnswer', 0);

  let attemptCreated = 0;
  let answerCreated = 0;
  let attemptSkipped = 0;

  for (const u of legacy) {
    const userId = await resolveId('User', u.id);
    if (!userId) {
      // Count and skip
      const count = (u.examResults || []).length +
        Object.values(u.quizResults || {}).reduce((s, v) => s + Object.keys(v || {}).length, 0);
      attemptSkipped += count;
      if (count > 0) logger.logSkipped('ExamAttempt', u.id, 'user not in IdMapping');
      continue;
    }

    // Process examResults[]
    if (u.examResults && Array.isArray(u.examResults)) {
      for (const er of u.examResults) {
        try {
          const courseId = er.courseId ? await resolveId('Course', er.courseId) : null;

          const existing = await prisma.examAttempt.findFirst({
            where: { userId, examId: er.examId, type: 'exam' },
          });
          if (existing) { attemptSkipped++; continue; }

          if (dryRun) { attemptCreated++; continue; }

          await prisma.examAttempt.create({
            data: {
              id: newCuid(),
              userId,
              courseId,
              type: 'exam',
              examId: safeString(er.examId),
              status: 'completed',
              answers: {},
              score: safeNumber(er.score, null),
              total: safeNumber(er.total, null),
              startTime: safeDate(er.date) || safeDate(er.completedAt) || null,
              endTime: safeDate(er.completedAt) || safeDate(er.date) || null,
            },
          });
          logger.logCreated('ExamAttempt', `${u.id}:exam:${er.examId}`, er.examId);
          attemptCreated++;
        } catch (e) {
          logger.logFailed('ExamAttempt', `${u.id}:exam:${er.examId}`, e);
        }
      }
    }

    // Process quizResults{}
    if (u.quizResults) {
      for (const [legacyCourseId, courseQuiz] of Object.entries(u.quizResults)) {
        if (!courseQuiz) continue;
        const courseId = await resolveId('Course', legacyCourseId);

        for (const [legacyLessonId, qr] of Object.entries(courseQuiz)) {
          if (!qr) continue;
          try {
            const lessonId = await resolveId('Lesson', legacyLessonId);

            const existing = await prisma.examAttempt.findFirst({
              where: { userId, examId: legacyLessonId, type: 'quiz' },
            });
            if (existing) { attemptSkipped++; continue; }

            if (dryRun) { attemptCreated++; continue; }

            const attemptId = newCuid();
            await prisma.examAttempt.create({
              data: {
                id: attemptId,
                userId,
                courseId,
                type: 'quiz',
                examId: legacyLessonId,
                status: qr.passed ? 'passed' : 'failed',
                answers: { selected: qr.answers || [] },
                score: safeNumber(qr.score, null),
                total: safeNumber(qr.total, null),
                startTime: null,
                endTime: safeDate(qr.completedAt) || null,
              },
            });
            logger.logCreated('ExamAttempt', `${u.id}:quiz:${legacyLessonId}`, attemptId);
            attemptCreated++;
          } catch (e) {
            logger.logFailed('ExamAttempt', `${u.id}:quiz:${legacyLessonId}`, e);
          }
        }
      }
    }
  }

  logger.found('ExamAttempt', examAttemptCount);
  logger.done('ExamAttempt', attemptCreated, attemptSkipped);
  logger.found('ExamAnswer', 0);
  logger.done('ExamAnswer', answerCreated, 0);

  const dbAttempts = await prisma.examAttempt.count();
  const dbAnswers = await prisma.examAnswer.count();

  return {
    report: logger.report(),
    summary: logger.summary(),
    legacyAttempts: examAttemptCount,
    dbAttempts,
    attemptCreated,
    attemptSkipped,
    legacyAnswers: 0,
    dbAnswers,
  };
}

function dryRunExams() {
  return migrateExams({ dryRun: true });
}

module.exports = { migrateExams, dryRunExams };
