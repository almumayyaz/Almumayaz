const { recordAuditLog, ACTIONS } = require('../utils/auditLog');
const { examAttemptRepo, userRepo } = require('../repositories');

function calculateRealEndTime(timeSettings, startedAt) {
  if (!timeSettings) return null;
  const start = new Date(startedAt).getTime();
  const ends = [];
  if (timeSettings.enableDuration && timeSettings.durationMinutes) {
    ends.push(start + timeSettings.durationMinutes * 60 * 1000);
  }
  if (timeSettings.enableAvailability && timeSettings.availableTo) {
    const to = new Date(timeSettings.availableTo).getTime();
    if (!isNaN(to)) ends.push(to);
  }
  if (ends.length === 0) return null;
  return new Date(Math.min(...ends));
}

function checkAvailability(timeSettings) {
  if (!timeSettings || !timeSettings.enableAvailability) return { allowed: true };
  const now = Date.now();
  if (timeSettings.availableFrom) {
    const from = new Date(timeSettings.availableFrom).getTime();
    if (!isNaN(from) && now < from) return { allowed: false, reason: 'الامتحان لم يبدأ بعد.' };
  }
  if (timeSettings.availableTo) {
    const to = new Date(timeSettings.availableTo).getTime();
    if (!isNaN(to) && now > to) return { allowed: false, reason: 'انتهت فترة إتاحة الامتحان.' };
  }
  return { allowed: true };
}

function calculateRemaining(realEndTime) {
  if (!realEndTime) return null;
  return Math.max(0, new Date(realEndTime).getTime() - Date.now());
}

async function start(uid, { examId, examType, courseId, timeSettings }) {
  const availability = checkAvailability(timeSettings);
  if (!availability.allowed) return { notAllowed: true, reason: availability.reason };

  let attempt = await examAttemptRepo.findFirst({ userId: uid, examId, status: 'in_progress' });
  if (attempt) {
    return {
      attempt: { id: attempt.id, startedAt: attempt.startTime, realEndTime: attempt.endTime, status: attempt.status, answers: attempt.answers || {} },
      serverTime: Date.now(),
      existing: true,
    };
  }

  const startedAt = new Date();
  const realEndTime = calculateRealEndTime(timeSettings, startedAt);
  attempt = await examAttemptRepo.create({
    userId: uid,
    examId: examId || '',
    type: examType || 'exam',
    courseId: courseId || '',
    status: 'in_progress',
    answers: {},
    startTime: startedAt,
    endTime: realEndTime,
  });

  return {
    attempt: { id: attempt.id, startedAt: attempt.startTime, realEndTime: attempt.endTime, status: attempt.status, answers: {} },
    serverTime: Date.now(),
  };
}

async function sync(uid, { attemptId }) {
  const attempt = await examAttemptRepo.findFirst({ id: attemptId, userId: uid });
  if (!attempt) return { notFound: true };
  const remaining = calculateRemaining(attempt.endTime);
  return { serverTime: Date.now(), remaining, status: attempt.status, realEndTime: attempt.endTime };
}

async function saveAnswers(uid, { attemptId, answers }) {
  const attempt = await examAttemptRepo.findFirst({ id: attemptId, userId: uid });
  if (!attempt) return { notFound: true };
  if (attempt.status !== 'in_progress') return { alreadySubmitted: true };
  await examAttemptRepo.update(attemptId, { answers });
  return {};
}

async function submit(uid, { attemptId, answers }) {
  const attempt = await examAttemptRepo.findFirst({ id: attemptId, userId: uid });
  if (!attempt) return { notFound: true };
  if (attempt.status !== 'in_progress') return { alreadySubmitted: true };
  const remaining = calculateRemaining(attempt.endTime);
  const newStatus = remaining !== null && remaining <= 0 ? 'auto_submitted' : 'submitted';
  await examAttemptRepo.update(attemptId, { status: newStatus, answers: answers || attempt.answers, endTime: new Date() });
  await recordAuditLog({ actorId: uid, action: ACTIONS.EXAM_SUBMIT, entity: 'ExamAttempt', entityId: attemptId, ip: uid });
  return { status: newStatus, submittedAt: new Date().toISOString() };
}

async function grade(uid, { attemptId, score, total }) {
  const attempt = await examAttemptRepo.findFirst({ id: attemptId, userId: uid });
  if (!attempt) return { notFound: true };
  await examAttemptRepo.update(attemptId, { score, total });
  const user = await userRepo.get(uid);
  if (user) {
    const progress = typeof user.progress === 'object' && user.progress ? { ...user.progress } : {};
    if (!progress.examResults) progress.examResults = {};
    progress.examResults[attempt.examId] = { score, total, date: new Date().toISOString() };
    await userRepo.update(uid, { progress });
  }
  await recordAuditLog({ actorId: uid, action: ACTIONS.EXAM_GRADE, entity: 'ExamAttempt', entityId: attemptId, metadata: { score, total }, ip: uid });
  return {};
}

module.exports = { start, sync, saveAnswers, submit, grade };
