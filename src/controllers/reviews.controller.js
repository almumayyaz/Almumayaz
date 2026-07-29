const { reviewService } = require('../services');

function actorId(req) {
  return req.user?.id || req.session?.user?.id;
}

async function list(req, res) {
  const reviews = await reviewService.listReviews(req.query);
  res.json(reviews);
}

async function getById(req, res) {
  const review = await reviewService.getReview(req.params.id);
  if (!review) return res.status(404).json({ error: 'المراجعة غير موجودة' });
  res.json(review);
}

async function create(req, res) {
  const review = await reviewService.createReview(req.body);
  res.status(201).json({ success: true, review });
}

async function update(req, res) {
  const updated = await reviewService.updateReview(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'المراجعة غير موجودة' });
  res.json({ success: true, review: updated });
}

async function remove(req, res) {
  const result = await reviewService.deleteReview(req.params.id, actorId(req));
  if (result === null) return res.status(404).json({ error: 'المراجعة غير موجودة' });
  res.json({ success: true });
}

async function setQuiz(req, res) {
  const quiz = await reviewService.setReviewQuiz(req.params.id, req.body);
  if (!quiz) return res.status(404).json({ error: 'المراجعة غير موجودة' });
  res.json({ success: true, quiz });
}

async function deleteQuiz(req, res) {
  const result = await reviewService.deleteReviewQuiz(req.params.id);
  if (result === null) return res.status(404).json({ error: 'المراجعة غير موجودة' });
  res.json({ success: true });
}

module.exports = { list, getById, create, update, remove, setQuiz, deleteQuiz };
