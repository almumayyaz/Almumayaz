const { subRequestService } = require('../services');

function actorId(req) {
  return req.user?.id || req.session?.user?.id;
}

async function list(req, res) {
  const enriched = await subRequestService.listSubRequests();
  res.json({ success: true, requests: enriched });
}

async function getById(req, res) {
  const request = await subRequestService.getSubRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'الطلب غير موجود' });
  res.json({ success: true, request });
}

async function approve(req, res) {
  const result = await subRequestService.approveSubRequest(req.params.id, actorId(req));
  if (!result) return res.status(404).json({ error: 'الطلب غير موجود' });
  res.json({ success: true, request: result });
}

async function reject(req, res) {
  const result = await subRequestService.rejectSubRequest(req.params.id, actorId(req));
  if (!result) return res.status(404).json({ error: 'الطلب غير موجود' });
  res.json({ success: true, request: result });
}

async function remove(req, res) {
  const result = await subRequestService.deleteSubRequest(req.params.id, actorId(req));
  if (result === null) return res.status(404).json({ error: 'الطلب غير موجود' });
  res.json({ success: true });
}

module.exports = { list, getById, approve, reject, remove };
