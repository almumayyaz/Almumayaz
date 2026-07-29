const { recordAuditLog } = require('../utils/auditLog');
const { questionBankRepo, courseRepo } = require('../repositories');

async function listQuestionBanks({ courseId } = {}) {
  const where = {};
  if (courseId) where.courseId = courseId;
  return questionBankRepo.query(where, { orderBy: { createdAt: 'desc' } });
}

async function getQuestionBank(id) {
  const bank = await questionBankRepo.get(id);
  if (!bank || bank.deletedAt) return null;
  return bank;
}

async function createQuestionBank(data, actor) {
  let stage = '', grade = '';
  if (data.courseId) {
    const course = await courseRepo.get(data.courseId);
    if (course) { stage = course.stage; grade = course.grade; }
  }
  const bank = await questionBankRepo.create({
    courseId: data.courseId || '',
    title: data.title || 'بنك أسئلة جديد',
    questions: data.questions || [],
    timerMinutes: data.timerMinutes || null,
    timeSettings: data.timeSettings || null,
  });
  await recordAuditLog({ actorId: actor, action: 'QUESTION_BANK_CREATE', entity: 'QuestionBank', entityId: bank.id, ip: data._ip, userAgent: data._ua });
  return bank;
}

async function updateQuestionBank(id, body) {
  const existing = await questionBankRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  const allowed = ['courseId', 'title', 'description', 'timerMinutes', 'timeSettings', 'questions'];
  const data = {};
  for (const field of allowed) {
    if (body[field] !== undefined) data[field] = body[field];
  }
  return questionBankRepo.update(id, data);
}

async function deleteQuestionBank(id, actor) {
  const existing = await questionBankRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  await questionBankRepo.softDelete(id, actor);
}

module.exports = { listQuestionBanks, getQuestionBank, createQuestionBank, updateQuestionBank, deleteQuestionBank };
