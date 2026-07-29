const { getStore } = require('../utils/cacheProvider');
const { userRepo, courseRepo, videoProgressRepo } = require('../repositories');

const progressCache = getStore();

async function heartbeat(uid, { courseId, lessonId, position, duration, watchedSeconds, forceComplete, videoId }) {
  const user = await userRepo.get(uid);
  if (!user) return { userNotFound: true };

  const progress = typeof user.progress === 'object' && user.progress ? { ...user.progress } : {};
  if (!progress[courseId]) {
    progress[courseId] = { completedLessons: [], percentage: 0, watchTime: 0, positions: {}, lessons: {} };
  }
  const cp = progress[courseId];
  const dur = Number(duration || 1) || 1;
  const pct = Math.min(100, Math.round((Number(position || 0) / dur) * 100));
  cp.percentage = pct;
  if (!cp.positions) cp.positions = {};
  cp.positions[lessonId] = Math.max(0, Math.floor(Number(position) || 0));
  if (watchedSeconds > 0) {
    cp.watchTime = (cp.watchTime || 0) + Number(watchedSeconds);
  }
  if (!cp.lessons) cp.lessons = {};
  if (!cp.lessons[lessonId]) cp.lessons[lessonId] = { watchTime: 0 };
  if (watchedSeconds > 0) {
    cp.lessons[lessonId].watchTime = (cp.lessons[lessonId].watchTime || 0) + Number(watchedSeconds);
  }
  if (forceComplete) {
    if (!cp.completedLessons.includes(lessonId)) cp.completedLessons.push(lessonId);
  }
  await userRepo.update(uid, { progress });

  if (videoId) {
    await videoProgressRepo.upsert(
      { studentId_lessonId_videoId: { studentId: uid, lessonId, videoId } },
      {
        studentId: uid,
        lessonId,
        videoId,
        lastPosition: Math.max(0, Math.floor(Number(position) || 0)),
        watchedSeconds: Number(watchedSeconds || 0),
        watchPercentage: pct,
        completed: !!forceComplete || pct >= 90,
        startedAt: new Date(),
        lastWatchAt: new Date(),
      },
      {
        lastPosition: Math.max(0, Math.floor(Number(position) || 0)),
        watchedSeconds: { increment: Number(watchedSeconds || 0) },
        watchPercentage: pct,
        completed: !!forceComplete || pct >= 90,
        lastWatchAt: new Date(),
      }
    );
  }

  progressCache.set(`progress:${uid}:${courseId}`, cp, 60000).catch(() => {});
  return cp;
}

async function markLessonComplete(uid, { courseId, lessonId, completed, percentage, position }) {
  const user = await userRepo.get(uid);
  if (!user) return { userNotFound: true };

  const progress = typeof user.progress === 'object' && user.progress ? { ...user.progress } : {};
  if (!progress[courseId]) {
    progress[courseId] = { completedLessons: [], percentage: 0, positions: {} };
  }
  const cp = progress[courseId];
  if (completed && !cp.completedLessons.includes(lessonId)) {
    cp.completedLessons.push(lessonId);
  }
  if (percentage !== undefined) cp.percentage = percentage;
  if (position !== undefined) {
    if (!cp.positions) cp.positions = {};
    cp.positions[lessonId] = Math.max(0, Math.floor(Number(position) || 0));
  }
  await userRepo.update(uid, { progress });
  return cp;
}

async function getProgress(uid, courseId) {
  const cached = await progressCache.get(`progress:${uid}:${courseId}`).catch(() => null);
  if (cached) return cached;
  const user = await userRepo.get(uid);
  if (!user) return { userNotFound: true };
  const progress = (user.progress && user.progress[courseId]) || { completedLessons: [], percentage: 0 };
  progressCache.set(`progress:${uid}:${courseId}`, progress, 30000).catch(() => {});
  return progress;
}

async function summary(uid) {
  const user = await userRepo.get(uid, { select: { progress: true } });
  const courses = await courseRepo.query({}, { select: { id: true, title: true, lessons: { where: { deletedAt: null }, select: { id: true } } } });
  const userProgress = user?.progress || {};
  return courses.map(c => {
    const cp = userProgress[c.id] || {};
    return {
      courseId: c.id,
      courseTitle: c.title,
      totalLessons: c.lessons.length,
      completedLessons: (cp.completedLessons || []).length,
      percentage: cp.percentage || 0,
      watchTime: cp.watchTime || 0,
    };
  });
}

module.exports = { heartbeat, markLessonComplete, getProgress, summary };
