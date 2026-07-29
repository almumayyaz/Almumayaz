const { quoteRepo } = require('../repositories');

async function listQuotes() {
  return quoteRepo.query({}, { orderBy: { createdAt: 'desc' } });
}

async function randomQuote() {
  const quotes = await quoteRepo.query({ active: true });
  if (!quotes.length) return { text: 'النجاح يبدأ بخطوة، وأنت على الطريق الصحيح', author: 'المُميز' };
  return quotes[Math.floor(Math.random() * quotes.length)];
}

async function createQuote(data) {
  return quoteRepo.create({ text: data.text || '', author: data.author || 'الأستاذ محمد عفيفي' });
}

async function updateQuote(id, body) {
  const existing = await quoteRepo.get(id);
  if (!existing) return null;
  const data = {};
  if (body.text !== undefined) data.text = body.text;
  if (body.author !== undefined) data.author = body.author;
  if (body.active !== undefined) data.active = body.active;
  return quoteRepo.update(id, data);
}

async function deleteQuote(id) {
  const existing = await quoteRepo.get(id);
  if (!existing) return null;
  await quoteRepo.hardDelete(id);
}

module.exports = { listQuotes, randomQuote, createQuote, updateQuote, deleteQuote };
