const { getPrisma } = require('../database');

/**
 * Build a backward-compatible legacy user object from normalized Prisma tables.
 *
 * Assembles data dynamically — never persists the assembled object.
 * Screens that still expect Firebase-style embedded documents (quizResults,
 * examResults, progress, subscriptionStatus, notifications, payments) will
 * continue to work without changes to frontend templates.
 *
 * @param {string} userId  Prisma User.id
 * @returns {Promise<object|null>}  User object with legacy fields attached
 */
async function buildLegacyUser(userId) {
  if (!userId) return null;
  const prisma = getPrisma();

  // 1. Load base user
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  // 2. Load normalized relations in parallel
  const [subscriptions, lessonProgress, videoProgress, payments, allNotifications] = await Promise.all([
    prisma.userSubscription.findMany({ where: { userId, deletedAt: null } }),
    prisma.lessonProgress.findMany({ where: { studentId: userId, deletedAt: null } }),
    prisma.videoProgress.findMany({ where: { studentId: userId, deletedAt: null } }),
    prisma.payment.findMany({ where: { userId, deletedAt: null } }),
    prisma.notification.findMany({ where: { userId, deletedAt: null } }),
    prisma.examAttempt.findMany({ where: { userId, deletedAt: null } }),
    prisma.referral.findMany({ where: { referrerId: userId, deletedAt: null } }),
  ]);

  // 3. Build quizResults map from examAttempts
  const quizResults = {};
  for (const attempt of examAttempts) {
    if (!attempt.quizId) continue;
    if (!quizResults[attempt.courseId]) quizResults[attempt.courseId] = {};
    const existing = quizResults[attempt.courseId][attempt.quizId];
    if (!existing || (attempt.passed && !existing.passed)) {
      quizResults[attempt.courseId][attempt.quizId] = {
        answers: attempt.answers || [],
        score: attempt.score || 0,
        total: attempt.total || 0,
        percentage: attempt.percentage || 0,
        passed: attempt.passed || false,
        completedAt: attempt.completedAt ? attempt.completedAt.getTime() : null,
      };
    }
  }

  // 4. Build progress map from lessonProgress + videoProgress
  const progressMap = {};
  for (const lp of lessonProgress) {
    if (!progressMap[lp.courseId]) {
      progressMap[lp.courseId] = { completedLessons: [], percentage: 0, positions: {}, watchTime: {} };
    }
    if (lp.completed) {
      progressMap[lp.courseId].completedLessons.push(lp.lessonId);
    }
    if (lp.watchTime != null) {
      progressMap[lp.courseId].watchTime[lp.lessonId] = lp.watchTime;
    }
  }
  for (const vp of videoProgress) {
    if (!progressMap[vp.courseId]) {
      progressMap[vp.courseId] = { completedLessons: [], percentage: 0, positions: {}, watchTime: {} };
    }
    if (vp.lastPosition != null) {
      progressMap[vp.courseId].positions[vp.lessonId] = vp.lastPosition;
    }
  }
  // Calculate percentage for each course
  for (const courseId of Object.keys(progressMap)) {
    const lessons = await prisma.lesson.findMany({
      where: { courseId, deletedAt: null },
      select: { id: true },
    });
    const count = lessons.length;
    const done = progressMap[courseId].completedLessons.length;
    progressMap[courseId].percentage = count > 0 ? Math.round((done / count) * 100) : 0;
  }

  // 5. Determine active subscription
  const activeSub = subscriptions.find(
    s => s.status === 'active' && (!s.endDate || new Date(s.endDate) > new Date())
  );

  // 6. Assemble legacy-compatible user object
  return {
    ...user,
    // Legacy subscription fields (mirror from UserSubscription if available)
    subscriptionStatus: activeSub ? 'active' : (subscriptions.length > 0 ? 'expired' : user.subscriptionStatus || 'inactive'),
    subscriptionStart: activeSub?.startDate || user.subscriptionStart,
    subscriptionEnd: activeSub?.endDate || user.subscriptionEnd,
    subscribedStage: activeSub?.stage || user.subscribedStage || '',
    planName: activeSub?.planName || user.planName || '',
    planPeriod: activeSub?.planPeriod || user.planPeriod || '',
    // Legacy embedded documents (assembled from normalized tables)
    quizResults,
    examResults: examAttempts.map(a => ({
      examId: a.quizId,
      courseId: a.courseId,
      examName: a.examName || '',
      score: a.score || 0,
      total: a.total || 0,
      correct: a.correct ?? a.score ?? 0,
      wrong: a.wrong ?? ((a.total || 0) - (a.score || 0)),
      percentage: a.percentage || (a.total > 0 ? Math.round(((a.score || 0) / a.total) * 100) : 0),
      date: a.completedAt ? a.completedAt.toISOString() : new Date().toISOString(),
      completedAt: a.completedAt ? a.completedAt.toISOString() : new Date().toISOString(),
      passed: a.passed || false,
    })),
    progress: progressMap,
    notifications: allNotifications,
    payments,
    subscriptions,
  };
}

module.exports = { buildLegacyUser };
