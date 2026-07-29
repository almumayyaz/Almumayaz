const { reviewRepo } = require('../repositories');

async function listReviews({ courseId, stage, grade } = {}) {
  const where = {};
  if (courseId) where.courseId = courseId;
  if (stage) where.stage = stage;
  if (grade) where.grade = grade;
  return reviewRepo.query(where, { orderBy: { order: 'asc' } });
}

async function getReview(id) {
  const review = await reviewRepo.get(id);
  if (!review || review.deletedAt) return null;
  return review;
}

async function createReview(data) {
  return reviewRepo.create({
    title: data.title || 'مراجعة جديدة',
    course: data.course || '',
    courseId: data.courseId || '',
    color: data.color || '#A07200',
    icon: data.icon || 'fa-book-open',
    desc: data.desc || '',
    videos: data.videos || (data.videoUrl ? [{ title: 'فيديو', url: data.videoUrl }] : []),
    pdfFiles: data.pdfFiles || (data.pdfUrl ? [{ title: 'ملف', url: data.pdfUrl }] : []),
    stage: data.stage || 'all',
    grade: data.grade || '',
    order: data.order !== undefined ? data.order : 0,
    isFree: data.isFree || false,
    date: new Date().toISOString().split('T')[0],
  });
}

async function updateReview(id, body) {
  const existing = await reviewRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  const allowed = ['title', 'course', 'courseId', 'color', 'icon', 'desc', 'videos', 'pdfFiles', 'stage', 'grade', 'order', 'isFree', 'date'];
  const data = {};
  for (const field of allowed) {
    if (body[field] !== undefined) data[field] = body[field];
  }
  return reviewRepo.update(id, data);
}

async function deleteReview(id, actor) {
  const existing = await reviewRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  await reviewRepo.softDelete(id, actor);
}

async function setReviewQuiz(id, body) {
  const existing = await reviewRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  const { title, questions, timerMinutes } = body;
  const quiz = {
    id: existing.quiz?.id || 'rq' + Date.now(),
    title: title || 'اختبار المراجعة',
    questions: questions || [],
    timerMinutes: timerMinutes ?? existing.quiz?.timerMinutes ?? null,
  };
  await reviewRepo.update(id, { quiz });
  return quiz;
}

async function deleteReviewQuiz(id) {
  const existing = await reviewRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  await reviewRepo.update(id, { quiz: null });
}

module.exports = { listReviews, getReview, createReview, updateReview, deleteReview, setReviewQuiz, deleteReviewQuiz };
