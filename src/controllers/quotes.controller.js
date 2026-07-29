const { quoteService } = require('../services');

async function list(req, res) {
  const quotes = await quoteService.listQuotes();
  res.json(quotes);
}

async function random(req, res) {
  const quote = await quoteService.randomQuote();
  res.json(quote);
}

async function create(req, res) {
  const quote = await quoteService.createQuote(req.body);
  res.status(201).json({ success: true, quote });
}

async function update(req, res) {
  const updated = await quoteService.updateQuote(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'الجملة غير موجودة' });
  res.json({ success: true, quote: updated });
}

async function remove(req, res) {
  const result = await quoteService.deleteQuote(req.params.id);
  if (result === null) return res.status(404).json({ error: 'الجملة غير موجودة' });
  res.json({ success: true });
}

module.exports = { list, random, create, update, remove };
