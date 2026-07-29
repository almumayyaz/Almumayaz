const { questionBankService } = require('../services');

function actorId(req) {
  return req.user?.id || req.session?.user?.id;
}

async function list(req, res) {
  const banks = await questionBankService.listQuestionBanks(req.query);
  res.json(banks);
}

async function getById(req, res) {
  const bank = await questionBankService.getQuestionBank(req.params.id);
  if (!bank) return res.status(404).json({ error: 'بنك الأسئلة غير موجود' });
  res.json(bank);
}

async function create(req, res) {
  const bank = await questionBankService.createQuestionBank({ ...req.body, _ip: req.headers['x-forwarded-for'] || req.ip, _ua: req.headers['user-agent'] }, actorId(req));
  res.status(201).json({ success: true, bank });
}

async function update(req, res) {
  const updated = await questionBankService.updateQuestionBank(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'بنك الأسئلة غير موجود' });
  res.json({ success: true, bank: updated });
}

async function remove(req, res) {
  const result = await questionBankService.deleteQuestionBank(req.params.id, actorId(req));
  if (result === null) return res.status(404).json({ error: 'بنك الأسئلة غير موجود' });
  res.json({ success: true });
}

module.exports = { list, getById, create, update, remove };
