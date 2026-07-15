const { readData, writeData } = require('./firebase-admin');

const ROOT = 'studentAnalytics';

function now() { return new Date().toISOString(); }

function todayStr() { return new Date().toISOString().slice(0, 10); }

function defaultProfile(u) {
  return {
    name: u.name || '', email: u.email || '', phone: u.phone || '',
    stage: u.stage || '', grade: u.grade || '', governorate: u.governorate || '',
    subscriptionStatus: u.subscriptionStatus || 'inactive'
  };
}

function defaultAnalytics(u) {
  return {
    profile: defaultProfile(u),
    sessions: { totalLogins: 0, lastLogin: null, history: [] },
    watchHistory: { totalSeconds: 0, lessons: {} },
    lessonProgress: {},
    courseProgress: {},
    quizHistory: {},
    pdfHistory: { totalOpens: 0, lessons: {} },
    achievements: { unlocked: [], total: 0, perfectQuiz: false },
    activityLog: [],
    streak: { current: 0, longest: 0, lastStudyDate: null },
    summary: {
      totalWatchTime: 0, completedLessons: 0, completedCourses: 0,
      averageQuizScore: 0, overallProgress: 0, activityScore: 0,
      totalPDFsOpened: 0, totalQuizzes: 0, currentStreak: 0, longestStreak: 0
    },
    lastUpdated: now(), createdAt: now()
  };
}

function makeSummary(a) {
  const lp = a.lessonProgress || {};
  const cp = a.courseProgress || {};
  const qh = a.quizHistory || {};
  const s = a.streak || {};
  const wh = a.watchHistory || {};
  const ls = Object.keys(lp).filter(k => lp[k].status === 'completed').length;
  const cc = Object.keys(cp).filter(k => (cp[k].completionPercent || 0) >= 100).length;
  const tq = Object.keys(qh).length;
  let aqs = 0, perf = false;
  const allAttempts = [];
  Object.keys(qh).forEach(qk => { (qh[qk].attempts || []).forEach(at => { allAttempts.push(at); if ((at.percentage || 0) >= 100) perf = true; }); });
  if (allAttempts.length) aqs = Math.round(allAttempts.reduce((sum, at) => sum + (at.percentage || 0), 0) / allAttempts.length);
  const op = Object.keys(cp).length ? Math.round(Object.keys(cp).reduce((sum, k) => sum + (cp[k].completionPercent || 0), 0) / Object.keys(cp).length) : 0;
  const tw = wh.totalSeconds || 0;
  const as_ = calcActivityScore({ totalWatchTime: tw, completedLessons: ls, averageQuizScore: aqs, currentStreak: s.current || 0 });
  return {
    totalWatchTime: tw, completedLessons: ls, completedCourses: cc,
    averageQuizScore: aqs, overallProgress: op, activityScore: as_,
    totalPDFsOpened: (a.pdfHistory || {}).totalOpens || 0,
    totalQuizzes: tq, currentStreak: s.current || 0, longestStreak: s.longest || 0,
    lastLesson: '', currentLesson: ''
  };
}

function calcActivityScore(sm) {
  const ws = Math.min((sm.totalWatchTime || 0) / 72000, 1) * 40;
  const ls = Math.min((sm.completedLessons || 0) / 50, 1) * 30;
  const qs = ((sm.averageQuizScore || 0) / 100) * 20;
  const ss = Math.min((sm.currentStreak || 0) / 30, 1) * 10;
  return Math.round(ws + ls + qs + ss);
}

const ACHIEVEMENT_DEFS = [
  { id: 'first_lesson', name: 'أول درس', desc: 'إكمال أول درس', icon: 'fa-play-circle', cat: 'lessons' },
  { id: 'first_quiz', name: 'أول اختبار', desc: 'حل أول اختبار', icon: 'fa-question-circle', cat: 'quiz' },
  { id: 'five_lessons', name: '5 دروس', desc: 'إكمال 5 دروس', icon: 'fa-star', cat: 'lessons' },
  { id: 'ten_lessons', name: '10 دروس', desc: 'إكمال 10 دروس', icon: 'fa-star', cat: 'lessons' },
  { id: 'twenty_five_lessons', name: '25 درس', desc: 'إكمال 25 درس', icon: 'fa-trophy', cat: 'lessons' },
  { id: 'fifty_lessons', name: '50 درس', desc: 'إكمال 50 درس', icon: 'fa-trophy', cat: 'lessons' },
  { id: 'hundred_lessons', name: '100 درس', desc: 'إكمال 100 درس', icon: 'fa-crown', cat: 'lessons' },
  { id: 'five_hours', name: '5 ساعات', desc: 'مشاهدة 5 ساعات', icon: 'fa-clock', cat: 'watch' },
  { id: 'twenty_hours', name: '20 ساعة', desc: 'مشاهدة 20 ساعة', icon: 'fa-clock', cat: 'watch' },
  { id: 'seven_day_streak', name: 'مواظبة 7 أيام', desc: 'المذاكرة 7 أيام متتالية', icon: 'fa-fire', cat: 'streak' },
  { id: 'thirty_day_streak', name: 'مواظبة 30 يوم', desc: 'المذاكرة 30 يوم متتالية', icon: 'fa-fire', cat: 'streak' },
  { id: 'perfect_quiz', name: 'امتياز', desc: 'الحصول على 100% في اختبار', icon: 'fa-medal', cat: 'quiz' },
  { id: 'hundred_percent_course', name: 'أكملت كورس كامل', desc: 'إكمال كورس كامل', icon: 'fa-graduation-cap', cat: 'course' },
  { id: 'fifty_quizzes', name: '50 اختبار', desc: 'حل 50 اختبار', icon: 'fa-pen', cat: 'quiz' }
];

function checkConditions(a) {
  const sm = a.summary || makeSummary(a);
  const unlocked = {};
  (a.achievements.unlocked || []).forEach(id => { unlocked[id] = true; });
  const newly = [];
  const conditions = {
    first_lesson: () => sm.completedLessons >= 1,
    first_quiz: () => sm.totalQuizzes >= 1,
    five_lessons: () => sm.completedLessons >= 5,
    ten_lessons: () => sm.completedLessons >= 10,
    twenty_five_lessons: () => sm.completedLessons >= 25,
    fifty_lessons: () => sm.completedLessons >= 50,
    hundred_lessons: () => sm.completedLessons >= 100,
    five_hours: () => sm.totalWatchTime >= 18000,
    twenty_hours: () => sm.totalWatchTime >= 72000,
    seven_day_streak: () => sm.currentStreak >= 7,
    thirty_day_streak: () => sm.currentStreak >= 30,
    perfect_quiz: () => !!(a.achievements || {}).perfectQuiz,
    hundred_percent_course: () => sm.completedCourses >= 1,
    fifty_quizzes: () => sm.totalQuizzes >= 50
  };
  Object.keys(conditions).forEach(id => {
    if (!unlocked[id] && conditions[id]()) {
      newly.push(id);
      unlocked[id] = true;
    }
  });
  return { newly, unlocked: Object.keys(unlocked) };
}

async function getOrCreate(uid) {
  let a = await readData(ROOT + '/' + uid);
  if (!a) {
    const users = await readData('users');
    const u = (users || []).find(u => u.uid === uid) || {};
    a = defaultAnalytics(u);
    await writeData(ROOT + '/' + uid, a);
  }
  if (!a.summary) a.summary = makeSummary(a);
  if (!a.achievements) a.achievements = { unlocked: [], total: 0, perfectQuiz: false };
  if (!a.streak) a.streak = { current: 0, longest: 0, lastStudyDate: null };
  if (!a.watchHistory) a.watchHistory = { totalSeconds: 0, lessons: {} };
  if (!a.watchHistory.lessons) a.watchHistory.lessons = {};
  if (!a.lessonProgress) a.lessonProgress = {};
  if (!a.courseProgress) a.courseProgress = {};
  if (!a.quizHistory) a.quizHistory = {};
  if (!a.pdfHistory) a.pdfHistory = { totalOpens: 0, lessons: {} };
  if (!a.pdfHistory.lessons) a.pdfHistory.lessons = {};
  if (!a.activityLog) a.activityLog = [];
  if (!a.sessions) a.sessions = { totalLogins: 0, lastLogin: null, history: [] };
  if (!a.profile) a.profile = {};
  a.summary.currentStreak = (a.streak || {}).current || 0;
  a.summary.longestStreak = (a.streak || {}).longest || 0;
  return a;
}

async function persist(uid, a) {
  a.lastUpdated = now();
  a.summary = makeSummary(a);
  a.achievements.total = (a.achievements.unlocked || []).length;
  await writeData(ROOT + '/' + uid, a);
}

async function recalcAndPersist(uid, a) {
  const r = checkConditions(a);
  if (r.newly.length) {
    const existing = a.achievements.unlocked || [];
    a.achievements.unlocked = [...new Set([...existing, ...r.newly])];
    for (const id of r.newly) {
      const ad = ACHIEVEMENT_DEFS.find(d => d.id === id);
      if (ad) await recordActivity(uid, 'achievement_unlocked', 'achievement:' + id, { achievementName: ad.name, achievementId: id }, a);
    }
  }
  await updateStreakInternal(uid, a);
  await persist(uid, a);
}

async function recordActivity(uid, action, target, meta, a) {
  a = a || await getOrCreate(uid);
  const entry = { timestamp: now(), action, target, metadata: meta || {} };
  a.activityLog = a.activityLog || [];
  a.activityLog.push(entry);
  if (a.activityLog.length > 500) a.activityLog = a.activityLog.slice(-500);
  return a;
}

async function updateStreakInternal(uid, a) {
  const today = todayStr();
  const last = a.streak.lastStudyDate;
  if (!last || last === today) {
    a.streak.current = a.streak.current || 1;
  } else {
    const lastDate = new Date(last);
    const todayDate = new Date(today);
    const diff = Math.round((todayDate - lastDate) / 86400000);
    if (diff === 1) {
      a.streak.current = (a.streak.current || 0) + 1;
    } else if (diff > 1) {
      a.streak.current = 1;
    }
  }
  a.streak.lastStudyDate = today;
  if ((a.streak.current || 0) > (a.streak.longest || 0)) a.streak.longest = a.streak.current;
  return a;
}

async function getAnalytics(uid) {
  return getOrCreate(uid);
}

async function trackLogin(uid, reqInfo) {
  const a = await getOrCreate(uid);
  a.sessions.totalLogins = (a.sessions.totalLogins || 0) + 1;
  a.sessions.lastLogin = now();
  const entry = {
    date: now().slice(0, 10), time: now(), device: reqInfo.device || '',
    browser: reqInfo.browser || '', ip: reqInfo.ip || '',
    sessionStart: now(), lastActive: now(), sessionDuration: 0
  };
  a.sessions.history = a.sessions.history || [];
  a.sessions.history.push(entry);
  if (a.sessions.history.length > 200) a.sessions.history = a.sessions.history.slice(-200);
  a.profile.lastLogin = now();
  await recalcAndPersist(uid, a);
}

async function completeLesson(uid, cid, lid, lk, a) {
  const users = await readData('users');
  const ui = (users || []).findIndex(u => u.uid === uid);
  if (ui >= 0) {
    users[ui].progress = users[ui].progress || {};
    users[ui].progress[cid] = users[ui].progress[cid] || {};
    const cp = users[ui].progress[cid];
    if (!cp.completedLessons) cp.completedLessons = [];
    if (!cp.completedLessons.includes(lid)) cp.completedLessons.push(lid);
    if (!cp.percentage && cp.percentage !== 0) cp.percentage = 0;
    const courses = await readData('courses');
    const course = (courses || []).find(c => c.id === cid);
    const totalLessons = (course && course.lessons) ? course.lessons.length : 1;
    cp.percentage = Math.round((cp.completedLessons.length / totalLessons) * 100);
    await writeData('users', users);
    await recordActivity(uid, 'lesson_completed', 'lesson:' + cid + ':' + lid, { courseId: cid, lessonId: lid, courseName: course ? course.title : '' }, a);
  }
}

async function trackVideoHeartbeat(uid, cid, lid, position, duration, watchedSeconds, forceComplete) {
  const a = await getOrCreate(uid);
  const lk = cid + '_' + lid;
  const pct = duration > 0 ? Math.min(Math.round((position / duration) * 100), 100) : 0;
  const isComplete = forceComplete || pct >= 95;
  const wh = a.watchHistory;
  if (!wh || !wh.lessons) { console.error('ANALYTICS_BUG: wh.lessons is falsy', JSON.stringify({ uid, cid, lid, whType: typeof wh, wh })); }
  wh.lessons[lk] = wh.lessons[lk] || { lessonId: lid, courseId: cid, firstWatch: now(), lastWatch: now(), opens: 0, totalSeconds: 0, completionPercent: 0, completed: false, resumePosition: 0 };
  const wl = wh.lessons[lk];
  if (!wl.firstWatch) wl.firstWatch = now();
  wl.lastWatch = now();
  wl.resumePosition = position;
  if (watchedSeconds > 0 && watchedSeconds < 120) {
    wl.totalSeconds = (wl.totalSeconds || 0) + watchedSeconds;
    wh.totalSeconds = (wh.totalSeconds || 0) + watchedSeconds;
  }
  if (pct > (wl.completionPercent || 0)) wl.completionPercent = pct;
  const lp = a.lessonProgress;
  lp[lk] = lp[lk] || { status: 'not_started', completionDate: null, watchTime: 0 };
  if (!lp[lk].completionDate && !lp[lk].firstOpen) lp[lk].firstOpen = now();
  if (watchedSeconds > 0 && watchedSeconds < 120) {
    lp[lk].watchTime = (lp[lk].watchTime || 0) + watchedSeconds;
  }
  if (isComplete && lp[lk].status !== 'completed') {
    lp[lk].status = 'completed';
    lp[lk].completionDate = now();
    wl.completed = true;
    await completeLesson(uid, cid, lid, lk, a);
  } else if (!isComplete && lp[lk].status !== 'completed') {
    lp[lk].status = 'watching';
  }
  const coursesForCp = await readData('courses');
  const courseForCp = (coursesForCp || []).find(c => c.id === cid);
  if (courseForCp && courseForCp.lessons) {
    const cpl = courseForCp.lessons.length;
    const cl = a.courseProgress[cid] = a.courseProgress[cid] || { completedLessons: 0, totalLessons: cpl, completionPercent: 0, averageWatchPercent: 0 };
    cl.totalLessons = cpl;
    const completedCount = Object.keys(a.lessonProgress).filter(k => k.startsWith(cid + '_') && a.lessonProgress[k].status === 'completed').length;
    cl.completedLessons = completedCount;
    cl.completionPercent = cpl ? Math.round((completedCount / cpl) * 100) : 0;
    const totalWatchPct = Object.keys(a.lessonProgress).filter(k => k.startsWith(cid + '_')).reduce((sum, k) => {
      const whl = wh.lessons[k];
      return sum + ((whl && whl.completionPercent) || 0);
    }, 0);
    cl.averageWatchPercent = cpl ? Math.round(totalWatchPct / cpl) : 0;
  }
  await recalcAndPersist(uid, a);
  return { completed: lp[lk].status === 'completed', completionPercent: wl.completionPercent || 0, status: lp[lk].status };
}

async function trackPdfOpen(uid, cid, lid, lessonTitle) {
  const a = await getOrCreate(uid);
  const lk = cid + '_' + lid;
  const ph = a.pdfHistory;
  ph.totalOpens = (ph.totalOpens || 0) + 1;
  ph.lessons[lk] = ph.lessons[lk] || { lessonId: lid, courseId: cid, opens: 0, readingDuration: 0 };
  ph.lessons[lk].opens = (ph.lessons[lk].opens || 0) + 1;
  await recordActivity(uid, 'pdf_opened', 'pdf:' + cid + ':' + lid, { courseId: cid, lessonId: lid, lessonTitle: lessonTitle || '' }, a);
  await recalcAndPersist(uid, a);
}

async function trackQuizSubmit(uid, cid, qid, quizTitle, score, total, correct, wrong, timeTaken) {
  const a = await getOrCreate(uid);
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
  a.quizHistory[qid] = a.quizHistory[qid] || { quizId: qid, courseId: cid, quizTitle: quizTitle || '', attempts: [] };
  const at = {
    score, percentage: pct, correct, wrong, timeTaken: timeTaken || 0,
    attemptNumber: (a.quizHistory[qid].attempts.length || 0) + 1, date: now()
  };
  a.quizHistory[qid].attempts.push(at);
  if (pct >= 100) a.achievements.perfectQuiz = true;
  await recordActivity(uid, 'quiz_submitted', 'quiz:' + cid + ':' + qid, { courseId: cid, quizId: qid, quizTitle: quizTitle || '', score, percentage: pct }, a);
  await recalcAndPersist(uid, a);
  return { attemptNumber: at.attemptNumber, percentage: pct };
}

function computeLessonStatuses(uid, course, lessonProgress, courseProgress) {
  const lessons = (course.lessons || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const statuses = [];
  lessons.forEach((l, i) => {
    const lk = course.id + '_' + l.id;
    const lp = (lessonProgress || {})[lk] || {};
    const isCompleted = lp.status === 'completed';
    const isWatching = lp.status === 'watching';
    let isUnlocked;
    if (i === 0) {
      isUnlocked = true;
    } else {
      const prevLesson = lessons[i - 1];
      const prevLk = course.id + '_' + prevLesson.id;
      const prevLp = (lessonProgress || {})[prevLk] || {};
      isUnlocked = prevLp.status === 'completed';
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

async function getStudentDashboardData(uid) {
  const a = await getOrCreate(uid);
  const sm = a.summary || makeSummary(a);
  const cp = a.courseProgress || {};
  const courses = await readData('courses');
  const courseList = (courses || []).filter(c => c.stage === a.profile.stage || !c.stage);
  let lastLessonTitle = '', currentLessonTitle = '';
  const courseProgress = courseList.map(c => {
    const p = cp[c.id] || { completedLessons: 0, totalLessons: (c.lessons || []).length, completionPercent: 0, averageWatchPercent: 0 };
    const computed = computeLessonStatuses(uid, c, a.lessonProgress, cp);
    if (computed.currentLesson) currentLessonTitle = computed.currentLesson.title;
    if (computed.lastLesson) lastLessonTitle = computed.lastLesson.title;
    return { courseId: c.id, courseTitle: c.title, courseIcon: c.icon, courseColor: c.color, ...p };
  });
  const achievements = ACHIEVEMENT_DEFS.map(ad => ({
    ...ad, unlocked: (a.achievements.unlocked || []).includes(ad.id)
  }));
  const qh = a.quizHistory || {};
  const quizResults = [];
  Object.keys(qh).forEach(qk => {
    const q = qh[qk];
    (q.attempts || []).forEach((at, i) => {
      quizResults.push({
        quizTitle: q.quizTitle || qk, score: at.score, percentage: at.percentage,
        date: at.date, attemptNumber: at.attemptNumber || (i + 1)
      });
    });
  });
  const recentActivity = (a.activityLog || []).slice(-20).reverse();
  return {
    progress: { ...sm, lastLesson: lastLessonTitle, currentLesson: currentLessonTitle },
    courseProgress, quizResults, achievements,
    unlockedAchievements: (a.achievements.unlocked || []).length,
    totalAchievements: ACHIEVEMENT_DEFS.length,
    recentActivity, streak: a.streak || { current: 0, longest: 0, lastStudyDate: null }
  };
}

async function getAdminAnalytics() {
  const users = await readData('users');
  const allAnalytics = await readData(ROOT) || {};
  const students = (users || []).filter(u => u.role === 'student');
  const courses = await readData('courses') || [];
  const studentRows = [];
  const analyticsIds = Object.keys(allAnalytics);
  analyticsIds.forEach(uid => {
    const a = allAnalytics[uid];
    if (!a || !a.summary) return;
    const u = (users || []).find(u => u.uid === uid);
    const sm = a.summary || {};
    studentRows.push({ uid, name: (u || {}).name || a.profile.name || '', email: (u || {}).email || a.profile.email || '', summary: sm, profile: a.profile || {} });
  });
  const totalWatchTime = studentRows.reduce((s, r) => s + (r.summary.totalWatchTime || 0), 0);
  const avgWatchTime = studentRows.length ? Math.round(totalWatchTime / studentRows.length) : 0;
  const completedCount = studentRows.filter(r => (r.summary.completedLessons || 0) > 0).length;
  const avgQuizAll = [];
  studentRows.forEach(r => { if ((r.summary.averageQuizScore || 0) > 0) avgQuizAll.push(r.summary.averageQuizScore); });
  const avgQuizScore = avgQuizAll.length ? Math.round(avgQuizAll.reduce((a, b) => a + b, 0) / avgQuizAll.length) : 0;
  studentRows.sort((a, b) => (b.summary.activityScore || 0) - (a.summary.activityScore || 0));
  const topActive = studentRows.slice(0, 10);
  const leastActive = [...studentRows].sort((a, b) => (a.summary.activityScore || 0) - (b.summary.activityScore || 0)).slice(0, 10);
  const dailyActive = studentRows.filter(r => (r.summary.currentStreak > 0) || (r.profile.lastLogin || '').startsWith(todayStr())).length;
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
  const weekStr = weekAgo.toISOString().slice(0, 10);
  const weeklyActive = studentRows.filter(r => (r.profile.lastLogin || '').slice(0, 10) >= weekStr).length;
  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
  const monthStr = monthAgo.toISOString().slice(0, 10);
  const monthlyActive = studentRows.filter(r => (r.profile.lastLogin || '').slice(0, 10) >= monthStr).length;
  const noActivity = studentRows.filter(r => !r.summary.totalWatchTime && !r.summary.completedLessons).length;
  const mostCompletedLessons = [...studentRows].sort((a, b) => (b.summary.completedLessons || 0) - (a.summary.completedLessons || 0)).slice(0, 10);
  const allLessons = {};
  (courses || []).forEach(c => (c.lessons || []).forEach(l => {
    const k = c.id + '_' + l.id;
    allLessons[k] = allLessons[k] || { courseTitle: c.title, lessonTitle: l.title, courseId: c.id, lessonId: l.id, totalStudents: 0, completedStudents: 0 };
    allLessons[k].totalStudents = studentRows.length;
    let completed = 0;
    analyticsIds.forEach(uid => {
      const a = allAnalytics[uid];
      if (a && a.lessonProgress && a.lessonProgress[k] && a.lessonProgress[k].status === 'completed') completed++;
    });
    allLessons[k].completedStudents = completed;
  }));
  const lessonAnalysis = Object.values(allLessons).map(l => ({
    ...l, completionRate: l.totalStudents ? Math.round((l.completedStudents / l.totalStudents) * 100) : 0
  })).sort((a, b) => a.completionRate - b.completionRate);
  const mostDifficult = lessonAnalysis.slice(0, 10);
  const allQuizzes = {};
  analyticsIds.forEach(uid => {
    const a = allAnalytics[uid];
    if (!a || !a.quizHistory) return;
    Object.keys(a.quizHistory).forEach(qk => {
      const q = a.quizHistory[qk];
      (q.attempts || []).forEach(at => {
        allQuizzes[qk] = allQuizzes[qk] || { quizId: qk, quizTitle: q.quizTitle || qk, courseId: q.courseId || '', totalAttempts: 0, totalScore: 0, totalCorrect: 0, totalWrong: 0, passCount: 0 };
        allQuizzes[qk].totalAttempts++;
        allQuizzes[qk].totalScore += at.percentage || 0;
        allQuizzes[qk].totalCorrect += at.correct || 0;
        allQuizzes[qk].totalWrong += at.wrong || 0;
        if ((at.percentage || 0) >= 50) allQuizzes[qk].passCount++;
      });
    });
  });
  const quizAnalysis = Object.values(allQuizzes).map(q => ({
    ...q, avgScore: q.totalAttempts ? Math.round(q.totalScore / q.totalAttempts) : 0,
    passRate: q.totalAttempts ? Math.round((q.passCount / q.totalAttempts) * 100) : 0
  })).sort((a, b) => a.avgScore - b.avgScore);
  const mostFailed = quizAnalysis.slice(0, 10);
  return {
    totalStudents: students.length, studentsWithAnalytics: studentRows.length,
    activeToday: dailyActive, activeThisWeek: weeklyActive, activeThisMonth: monthlyActive,
    noActivity, totalWatchTime, avgWatchTime, completedStudents: completedCount, avgQuizScore,
    topActive, leastActive, mostCompletedLessons,
    mostDifficultLessons: mostDifficult, mostFailedQuizzes: mostFailed,
    lessonAnalysis, quizAnalysis,
    allStudentsSummary: studentRows.map(r => ({ uid: r.uid, name: r.name, email: r.email, summary: r.summary, profile: r.profile }))
  };
}

async function getAdminStudentDetail(studentId) {
  const users = await readData('users');
  const u = (users || []).find(u => u.uid === studentId);
  const a = await getOrCreate(studentId);
  const dashboard = await getStudentDashboardData(studentId);
  const courses = await readData('courses') || [];
  const lessonDetails = [];
  Object.keys(a.lessonProgress || {}).forEach(k => {
    const lp = a.lessonProgress[k];
    const [cid, lid] = k.split('_');
    const course = courses.find(c => c.id === cid);
    const lesson = course ? (course.lessons || []).find(l => l.id === lid) : null;
    lessonDetails.push({
      key: k, courseId: cid, lessonId: lid, courseTitle: course ? course.title : '',
      lessonTitle: lesson ? lesson.title : '', status: lp.status, watchTime: lp.watchTime || 0,
      completionDate: lp.completionDate || ''
    });
  });
  lessonDetails.sort((a, b) => (b.completionDate || '') > (a.completionDate || '') ? 1 : -1);
  return {
    student: { ...(u || {}), profile: a.profile, streak: a.streak },
    analyticsSummary: a.summary,
    courseProgress: dashboard.courseProgress,
    quizResults: dashboard.quizResults,
    recentActivity: dashboard.recentActivity,
    lessonDetails, achievements: dashboard.achievements,
    unlockedCount: dashboard.unlockedAchievements,
    totalAchievements: dashboard.totalAchievements
  };
}

async function migrateAll() {
  const users = await readData('users');
  const allAnalytics = await readData(ROOT) || {};
  const students = (users || []).filter(u => u.role === 'student');
  let migrated = 0, skipped = 0, errors = 0;
  for (const u of students) {
    if (allAnalytics[u.uid]) { skipped++; continue; }
    try {
      const a = defaultAnalytics(u);
      if (u.progress && typeof u.progress === 'object') {
        Object.keys(u.progress).forEach(cid => {
          const p = u.progress[cid];
          if (!p || !Array.isArray(p.completedLessons)) return;
          p.completedLessons.forEach(lid => {
            const lk = cid + '_' + lid;
            a.lessonProgress[lk] = { status: 'completed', completionDate: '', watchTime: 0, firstOpen: '' };
            a.watchHistory.lessons[lk] = { lessonId: lid, courseId: cid, firstWatch: '', lastWatch: '', opens: 0, totalSeconds: 0, completionPercent: 100, completed: true, resumePosition: 0 };
          });
        });
      }
      if (u.activityLog && Array.isArray(u.activityLog)) {
        a.activityLog = u.activityLog.slice(-500);
        u.activityLog.forEach(entry => {
          if (entry.action === 'lesson_completed' && entry.target) {
            const parts = entry.target.split(':');
            if (parts.length >= 3) {
              const lk = parts[1] + '_' + parts[2];
              if (!a.lessonProgress[lk]) a.lessonProgress[lk] = { status: 'completed', completionDate: '', watchTime: 0, firstOpen: '' };
              a.lessonProgress[lk].status = 'completed';
            }
          }
        });
      }
      if (u.examResults && Array.isArray(u.examResults)) {
        u.examResults.forEach((er, i) => {
          if (!er) return;
          const qid = 'migrated_' + i;
          const pct = er.score || 0;
          const correct = Math.round((pct / 100) * 10);
          const wrong = 10 - correct;
          a.quizHistory[qid] = { quizId: qid, courseId: '', quizTitle: er.examName || '', attempts: [{ score: pct, percentage: pct, correct, wrong, timeTaken: 0, attemptNumber: 1, date: er.date || '' }] };
        });
      }
      a.summary = makeSummary(a);
      a.achievements.total = (a.achievements.unlocked || []).length;
      await writeData(ROOT + '/' + u.uid, a);
      migrated++;
    } catch (e) {
      console.error('Migration error for', u.uid, e.message);
      errors++;
    }
  }
  return { total: students.length, migrated, skipped, errors };
}

module.exports = {
  getAnalytics, trackLogin, trackVideoHeartbeat, trackPdfOpen, trackQuizSubmit,
  getStudentDashboardData, getAdminAnalytics, getAdminStudentDetail, migrateAll,
  computeLessonStatuses, makeSummary, calcActivityScore, ACHIEVEMENT_DEFS
};
