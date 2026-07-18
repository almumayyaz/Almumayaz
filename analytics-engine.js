const { readData, writeData, fbRemove } = require('./firebase-admin');

function now() { return new Date().toISOString(); }

// Build a lessonProgress-like object from user.progress (courseId_lessonId → { status, watchTime })
function buildLessonProgress(u, courses) {
  const lp = {};
  const p = (u && u.progress) || {};
  Object.keys(p).forEach(cid => {
    const cp = p[cid];
    if (!cp) return;
    const completed = new Set(cp.completedLessons || []);
    (courses || []).forEach(c => {
      if (c.id !== cid || !c.lessons) return;
      c.lessons.forEach(l => {
        const k = cid + '_' + l.id;
        const lessonWatch = cp.lessons && cp.lessons[l.id] && cp.lessons[l.id].watchTime;
        lp[k] = {
          status: completed.has(l.id) ? 'completed' : (lessonWatch > 0 ? 'watching' : 'not_started'),
          watchTime: lessonWatch || 0,
          completionDate: ''
        };
      });
    });
  });
  return lp;
}

function buildWatchHistory(u, courses) {
  const p = (u && u.progress) || {};
  const lessons = {};
  Object.keys(p).forEach(cid => {
    const cp = p[cid];
    if (!cp) return;
    const completed = new Set(cp.completedLessons || []);
    (courses || []).forEach(c => {
      if (c.id !== cid || !c.lessons) return;
      c.lessons.forEach(l => {
        const k = cid + '_' + l.id;
        const lessonWatch = cp.lessons && cp.lessons[l.id] && cp.lessons[l.id].watchTime;
        const pos = cp.positions && cp.positions[l.id];
        lessons[k] = {
          lessonId: l.id, courseId: cid, firstWatch: '', lastWatch: '', opens: 0,
          totalSeconds: lessonWatch || 0, completionPercent: completed.has(l.id) ? 100 : 0,
          completed: completed.has(l.id), resumePosition: pos || 0
        };
      });
    });
  });
  let totalSeconds = 0;
  Object.keys(lessons).forEach(k => { totalSeconds += lessons[k].totalSeconds || 0; });
  return { totalSeconds, lessons };
}

function buildCourseProgress(u, courses) {
  const cp = {};
  const p = (u && u.progress) || {};
  (courses || []).forEach(c => {
    const pc = p[c.id];
    if (!pc || !c.lessons) return;
    const completed = (pc.completedLessons || []).length;
    const total = c.lessons.length;
    cp[c.id] = {
      completedLessons: completed,
      totalLessons: total,
      completionPercent: total > 0 ? Math.round((completed / total) * 100) : 0,
      averageWatchPercent: total > 0 ? Math.round((completed / total) * 100) : 0
    };
  });
  return cp;
}

function buildQuizHistory(u) {
  const qh = {};
  const results = (u && u.examResults) || [];
  results.forEach(r => {
    const qid = r.examId || r.quizId || r.id || '';
    if (!qid) return;
    qh[qid] = qh[qid] || { quizId: qid, courseId: r.courseId || '', quizTitle: r.examName || r.quizTitle || '', attempts: [] };
    qh[qid].attempts.push({
      score: r.score || 0, percentage: r.percentage || (r.total > 0 ? Math.round((r.score / r.total) * 100) : 0),
      correct: r.correct || 0, wrong: r.wrong || 0, timeTaken: r.timeTaken || 0,
      attemptNumber: (qh[qid].attempts.length || 0) + 1, date: r.date || r.completedAt || ''
    });
  });
  return qh;
}

function makeSummaryFromUser(u, courses) {
  const p = (u && u.progress) || {};
  let totalWatchSeconds = 0, completedLessons = 0;
  Object.keys(p).forEach(cid => {
    const cp = p[cid];
    if (!cp) return;
    totalWatchSeconds += (cp.watchTime || 0);
    if (cp.completedLessons) completedLessons += cp.completedLessons.length;
  });
  const examResults = (u && u.examResults) || [];
  let avgQuiz = 0;
  if (examResults.length) {
    const scores = examResults.map(r => r.percentage || (r.total > 0 ? Math.round((r.score / r.total) * 100) : 0) || r.score || 0);
    avgQuiz = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }
  const activityScore = calcActivityScore({ totalWatchTime: totalWatchSeconds, completedLessons, averageQuizScore: avgQuiz, currentStreak: 0 });
  return {
    totalWatchTime: totalWatchSeconds, completedLessons, completedCourses: 0,
    averageQuizScore: avgQuiz, overallProgress: 0, activityScore,
    totalPDFsOpened: 0, totalQuizzes: examResults.length, currentStreak: 0, longestStreak: 0
  };
}

function calcActivityScore(sm) {
  const ws = Math.min((sm.totalWatchTime || 0) / 72000, 1) * 40;
  const ls = Math.min((sm.completedLessons || 0) / 50, 1) * 30;
  const qs = ((sm.averageQuizScore || 0) / 100) * 20;
  const ss = Math.min((sm.currentStreak || 0) / 30, 1) * 10;
  return Math.round(ws + ls + qs + ss);
}

// Return an analytics-like object built entirely from users array (no Firebase studentAnalytics store)
async function getAnalytics(uid) {
  const users = await readData('users');
  const u = (users || []).find(u => u.uid === uid || u.id === uid) || {};
  const courses = await readData('courses') || [];
  const lp = buildLessonProgress(u, courses);
  const cp = buildCourseProgress(u, courses);
  const qh = buildQuizHistory(u);
  const wh = buildWatchHistory(u, courses);
  const sm = makeSummaryFromUser(u, courses);
  const pf = {
    name: u.name || '', email: u.email || '', phone: u.phone || '',
    stage: u.stage || '', grade: u.grade || '', governorate: u.governorate || '',
    subscriptionStatus: u.subscriptionStatus || 'inactive', lastLogin: u.lastLogin || ''
  };
  return {
    profile: pf, lessonProgress: lp, courseProgress: cp, quizHistory: qh,
    summary: sm, watchHistory: wh,
    pdfHistory: { totalOpens: 0, lessons: {} },
    achievements: { unlocked: [], total: 0, perfectQuiz: false },
    streak: { current: 0, longest: 0, lastStudyDate: null },
    activityLog: [], sessions: { totalLogins: 0, lastLogin: null, history: [] }
  };
}

// No-op tracking functions — actual data is stored by app.js directly in users array
async function trackLogin(uid, reqInfo) {}
async function trackVideoHeartbeat(uid, cid, lid, position, duration, watchedSeconds, forceComplete) {
  const pct = duration > 0 ? Math.min(Math.round((position / duration) * 100), 100) : 0;
  const isComplete = forceComplete || pct >= 95;
  return { completed: isComplete, completionPercent: pct, status: isComplete ? 'completed' : 'watching' };
}
async function trackPdfOpen(uid, cid, lid, lessonTitle) {}
async function trackQuizSubmit(uid, cid, qid, quizTitle, score, total, correct, wrong, timeTaken) {
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
  return { attemptNumber: 1, percentage: pct };
}

// Lesson unlock chain — pure computation (no DB reads)
function computeLessonStatuses(uid, course, lessonProgress, courseProgress, completedFromUser) {
  const userCompleted = completedFromUser || [];
  const lessons = (course.lessons || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const statuses = [];
  lessons.forEach((l, i) => {
    const lk = course.id + '_' + l.id;
    const lp = (lessonProgress || {})[lk] || {};
    const inUser = userCompleted.indexOf(l.id) !== -1;
    const isCompleted = lp.status === 'completed' || inUser;
    const isWatching = !isCompleted && lp.status === 'watching';
    let isUnlocked;
    if (i === 0) {
      isUnlocked = true;
    } else {
      const prevLesson = lessons[i - 1];
      const prevLk = course.id + '_' + prevLesson.id;
      const prevLp = (lessonProgress || {})[prevLk] || {};
      const prevInUser = userCompleted.indexOf(prevLesson.id) !== -1;
      isUnlocked = prevLp.status === 'completed' || prevInUser;
    }
    statuses.push({
      lessonId: l.id, title: l.title, order: l.order || i,
      isUnlocked, isCompleted, isWatching,
      duration: l.duration || '', isFree: !!l.isFree,
      hasVideo: !!(l.videos && l.videos.length) || !!l.videoUrl
    });
  });
  const currentLesson = statuses.find(s => s.isUnlocked && !s.isCompleted);
  const lastLesson = statuses.filter(s => s.isCompleted).pop();
  const cp = courseProgress || {};
  return { lessonStatuses: statuses, currentLesson, lastLesson };
}

// Student dashboard — built from users array + courses
async function getStudentDashboardData(uid) {
  const users = await readData('users');
  const u = (users || []).find(u => u.uid === uid || u.id === uid) || {};
  const courses = await readData('courses') || [];
  const lp = buildLessonProgress(u, courses);
  const cp = buildCourseProgress(u, courses);
  const sm = makeSummaryFromUser(u, courses);
  const courseList = (courses || []).filter(c => c.stage === u.stage || !c.stage);
  let lastLessonTitle = '', currentLessonTitle = '';
  const courseProgress = courseList.map(c => {
    const p = cp[c.id] || { completedLessons: 0, totalLessons: (c.lessons || []).length, completionPercent: 0, averageWatchPercent: 0 };
    const computed = computeLessonStatuses(uid, c, lp, cp);
    if (computed.currentLesson) currentLessonTitle = computed.currentLesson.title;
    if (computed.lastLesson) lastLessonTitle = computed.lastLesson.title;
    return { courseId: c.id, courseTitle: c.title, courseIcon: c.icon, courseColor: c.color, ...p };
  });
  const achievements = [];
  const quizResults = [];
  const results = (u && u.examResults) || [];
  results.forEach(r => {
    quizResults.push({
      quizTitle: r.examName || r.quizTitle || '',
      score: r.score || 0,
      percentage: r.percentage || (r.total > 0 ? Math.round((r.score / r.total) * 100) : 0),
      date: r.date || r.completedAt || '',
      attemptNumber: 1
    });
  });
  const recentActivity = [];
  if (u && u.progress) {
    Object.keys(u.progress).forEach(cid => {
      const p = u.progress[cid];
      if (!p) return;
      if (p.completedLessons) {
        p.completedLessons.forEach(lid => {
          recentActivity.push({ action: 'lesson_completed', timestamp: p.updatedAt || now(), courseId: cid, lessonId: lid, date: p.updatedAt || '' });
        });
      }
    });
  }
  results.forEach(r => {
    recentActivity.push({ action: 'quiz_submitted', timestamp: r.date || now(), metadata: { quizTitle: r.examName || '', percentage: r.percentage || (r.total > 0 ? Math.round((r.score / r.total) * 100) : 0) || r.score || 0 }, date: r.date || '' });
  });
  recentActivity.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return {
    progress: { ...sm, lastLesson: lastLessonTitle, currentLesson: currentLessonTitle },
    courseProgress, quizResults, achievements,
    unlockedAchievements: 0, totalAchievements: 0,
    recentActivity: recentActivity.slice(0, 20),
    streak: { current: 0, longest: 0, lastStudyDate: null }
  };
}

// Admin analytics — compute from all users + courses
async function computeAdminAnalytics() {
  const users = await readData('users');
  const courses = await readData('courses') || [];
  const rows = [];
  (users || []).forEach(u => {
    if (!u || !u.uid || u.role !== 'student') return;
    const sm = makeSummaryFromUser(u, courses);
    rows.push({
      uid: u.uid, name: u.name || '', email: u.email || '',
      summary: sm,
      profile: { grade: u.grade || '', governorate: u.governorate || '', lastLogin: u.lastLogin || '', stage: u.stage || '', subscriptionStatus: u.subscriptionStatus || '' },
      whTotal: sm.totalWatchTime
    });
  });
  const totalStudents = rows.length;
  const totalWatchTime = rows.reduce((s, r) => s + r.whTotal, 0);
  const avgWatchTime = totalStudents ? Math.round(totalWatchTime / totalStudents) : 0;
  const now_ = Date.now();
  const day = 86400000;
  const dailyActive = rows.filter(r => {
    const ll = r.profile.lastLogin;
    return ll && (now_ - new Date(ll).getTime() < day);
  }).length;
  const weeklyActive = rows.filter(r => {
    const ll = r.profile.lastLogin;
    return ll && (now_ - new Date(ll).getTime() < 7 * day);
  }).length;
  const monthlyActive = rows.filter(r => {
    const ll = r.profile.lastLogin;
    return ll && (now_ - new Date(ll).getTime() < 30 * day);
  }).length;
  const completedCount = rows.filter(r => (r.summary.completedLessons || 0) > 0).length;
  let avgQuizAll = [];
  rows.forEach(r => { if ((r.summary.averageQuizScore || 0) > 0) avgQuizAll.push(r.summary.averageQuizScore); });
  const avgQuizScore = avgQuizAll.length ? Math.round(avgQuizAll.reduce((a, b) => a + b, 0) / avgQuizAll.length) : 0;
  const noActivity = rows.filter(r => !r.summary.totalWatchTime && !r.summary.completedLessons).length;
  const sorted = [...rows].sort((a, b) => (b.summary.activityScore || 0) - (a.summary.activityScore || 0));
  const topActive = sorted.slice(0, 10);
  const leastActive = [...rows].sort((a, b) => (a.summary.activityScore || 0) - (b.summary.activityScore || 0)).slice(0, 10);
  const mostCompletedLessons = [...rows].sort((a, b) => (b.summary.completedLessons || 0) - (a.summary.completedLessons || 0)).slice(0, 10);
  // Lesson analytics
  const lessonAnalytics = [];
  (courses || []).forEach(c => (c.lessons || []).forEach(l => {
    const k = c.id + '_' + l.id;
    let opens = 0, completed = 0, totalWatchSecs = 0, watchers = 0;
    const studentSecs = [];
    rows.forEach(r => {
      const u = (users || []).find(x => x.uid === r.uid);
      if (!u) return;
      const p = u.progress && u.progress[c.id];
      if (!p) return;
      const watchTime = p.lessons && p.lessons[l.id] && p.lessons[l.id].watchTime;
      const hasPos = p.positions && p.positions[l.id] != null;
      const comp = p.completedLessons && p.completedLessons.includes(l.id);
      if (!watchTime && !hasPos && !comp) return;
      opens++;
      if (comp) completed++;
      const secs = watchTime || 0;
      if (secs > 0) { totalWatchSecs += secs; watchers++; }
      studentSecs.push(secs);
    });
    const completionRate = opens ? Math.round((completed / opens) * 100) : 0;
    const avgWatch = watchers ? Math.round(totalWatchSecs / watchers) : 0;
    const avgPct = opens ? Math.round(studentSecs.reduce((s, v) => s + v, 0) / opens) : 0;
    const activityScore = Math.round((completionRate * 0.5) + (Math.min(avgWatch / 120, 1) * 100 * 0.3) + (opens > 5 ? 100 * 0.2 : 0));
    lessonAnalytics.push({ lessonId: l.id, courseId: c.id, courseTitle: c.title, lessonTitle: l.title, opens, completed, completionRate, averageWatchTimeSeconds: avgWatch, averageWatchPercent: avgPct, activityScore });
  }));
  // Exam analytics
  const examMap = {};
  rows.forEach(r => {
    const u = (users || []).find(x => x.uid === r.uid);
    if (!u || !u.examResults) return;
    u.examResults.forEach(e => {
      const qk = e.examId || e.quizId || e.id || '';
      if (!qk) return;
      examMap[qk] = examMap[qk] || { examId: qk, examTitle: e.examName || e.quizTitle || qk, courseId: e.courseId || '', students: 0, totalAttempts: 0, lastScores: [], passCount: 0 };
      examMap[qk].students++;
      examMap[qk].totalAttempts += 1;
      const pct = e.percentage || (e.total > 0 ? Math.round((e.score / e.total) * 100) : 0) || e.score || 0;
      examMap[qk].lastScores.push(pct);
      if (pct >= 50) examMap[qk].passCount++;
    });
  });
  const examAnalytics = Object.values(examMap).map(e => {
    const avgScore = e.lastScores.length ? Math.round(e.lastScores.reduce((s, v) => s + v, 0) / e.lastScores.length) : 0;
    const passRate = e.students ? Math.round((e.passCount / e.students) * 100) : 0;
    const averageAttempts = e.students ? Math.round((e.totalAttempts / e.students) * 10) / 10 : 0;
    const sorted = [...e.lastScores].sort((a, b) => a - b);
    const highestScore = sorted.length ? sorted[sorted.length - 1] : 0;
    const lowestScore = sorted.length ? sorted[0] : 0;
    return { examId: e.examId, examTitle: e.examTitle, courseId: e.courseId, students: e.students, totalAttempts: e.totalAttempts, averageScore: avgScore, passRate, averageAttempts, highestScore, lowestScore };
  });
  examAnalytics.sort((a, b) => b.students - a.students);
  const allTests = examAnalytics.map(e => ({
    id: e.examId, name: e.examTitle, studentsCount: e.students, averageScore: e.averageScore, successRate: e.passRate, averageAttempts: e.averageAttempts
  }));
  const bestTests = allTests.slice().sort((a, b) => b.averageScore - a.averageScore).slice(0, 4);
  const bestIds = new Set(bestTests.map(t => t.id));
  const worstTests = allTests.filter(t => !bestIds.has(t.id)).sort((a, b) => a.averageScore - b.averageScore).slice(0, 4);
  // Completion percentage
  const clampPct = v => Math.max(0, Math.min(100, v || 0));
  const studentCompletion = rows.map(r => {
    let available = 0, completed = 0;
    (courses || []).forEach(c => {
      if (c.stage !== r.profile.stage && c.stage) return;
      available += (c.lessons || []).length;
      const u = (users || []).find(x => x.uid === r.uid);
      if (!u) return;
      const p = u.progress && u.progress[c.id];
      if (p && p.completedLessons) completed += p.completedLessons.length;
    });
    const pct = available > 0 ? clampPct((completed / available) * 100) : 0;
    return { uid: r.uid, completed, available, percentage: pct };
  });
  const completionPercentage = studentCompletion.length
    ? clampPct(Math.round(studentCompletion.reduce((s, r) => s + r.percentage, 0) / studentCompletion.length))
    : 0;
  return {
    totalStudents, studentsWithAnalytics: rows.length,
    activeToday: dailyActive, activeThisWeek: weeklyActive, activeThisMonth: monthlyActive,
    noActivity, totalWatchTime, avgWatchTime, completedStudents: completedCount, avgQuizScore,
    completionPercentage, studentCompletion,
    topActive, leastActive, mostCompletedLessons,
    lessonAnalytics, examAnalytics, allTests, bestTests, worstTests,
    allStudentsSummary: rows.map(r => ({ uid: r.uid, name: r.name, email: r.email, summary: r.summary, profile: r.profile }))
  };
}

async function getAdminAnalytics() {
  return await computeAdminAnalytics();
}

async function getAdminStudentDetail(studentId) {
  const users = await readData('users');
  const u = (users || []).find(u => u.uid === studentId || u.id === studentId);
  const courses = await readData('courses') || [];
  const lp = buildLessonProgress(u, courses);
  const cp = buildCourseProgress(u, courses);
  const qh = buildQuizHistory(u);
  const sm = makeSummaryFromUser(u, courses);
  // Lesson details
  const lessonDetails = [];
  Object.keys(lp).forEach(k => {
    const lpe = lp[k];
    const [cid, lid] = k.split('_');
    const course = courses.find(c => c.id === cid);
    const lesson = course ? (course.lessons || []).find(l => l.id === lid) : null;
    lessonDetails.push({
      key: k, courseId: cid, lessonId: lid, courseTitle: course ? course.title : '',
      lessonTitle: lesson ? lesson.title : '', status: lpe.status, watchTime: lpe.watchTime || 0,
      completionDate: lpe.completionDate || ''
    });
  });
  lessonDetails.sort((a, b) => (a.courseId + '_' + a.lessonId) > (b.courseId + '_' + b.lessonId) ? 1 : -1);
  const dashboard = await getStudentDashboardData(studentId);
  return {
    student: { ...(u || {}), profile: { name: u.name, email: u.email, grade: u.grade, governorate: u.governorate, stage: u.stage, subscriptionStatus: u.subscriptionStatus, lastLogin: u.lastLogin }, streak: { current: 0, longest: 0 }, totalWatchSeconds: sm.totalWatchTime },
    analyticsSummary: { ...sm, totalWatchTime: sm.totalWatchTime },
    courseProgress: dashboard.courseProgress,
    quizResults: dashboard.quizResults,
    recentActivity: dashboard.recentActivity,
    lessonDetails, achievements: dashboard.achievements,
    unlockedCount: 0, totalAchievements: 0
  };
}

// Maintenance — all no-ops since there's no separate analytics store
async function migrateAll() { return { total: 0, migrated: 0, skipped: 0, errors: 0 }; }
async function deleteAllAnalytics() { return { deleted: 0 }; }
async function backupAnalytics() { return { success: true, name: '' }; }
async function cleanupOrphanAnalytics() { return { removed: 0 }; }

module.exports = {
  getAnalytics, trackLogin, trackVideoHeartbeat, trackPdfOpen, trackQuizSubmit,
  computeLessonStatuses, getStudentDashboardData, getAdminAnalytics,
  getAdminStudentDetail, migrateAll, deleteAllAnalytics, backupAnalytics, cleanupOrphanAnalytics
};
