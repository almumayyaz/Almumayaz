const { announcementService } = require('../services');

function actorId(req) {
  return req.user?.id || req.session?.user?.id;
}

async function list(req, res) {
  const announcements = await announcementService.listAnnouncements();
  res.json(announcements);
}

async function getById(req, res) {
  const ann = await announcementService.getAnnouncement(req.params.id);
  if (!ann) return res.status(404).json({ error: 'الإعلان غير موجود' });
  res.json(ann);
}

async function create(req, res) {
  const ann = await announcementService.createAnnouncement(req.body);
  res.status(201).json({ success: true, announcement: ann });
}

async function update(req, res) {
  const updated = await announcementService.updateAnnouncement(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'الإعلان غير موجود' });
  res.json({ success: true, announcement: updated });
}

async function remove(req, res) {
  const result = await announcementService.deleteAnnouncement(req.params.id, actorId(req));
  if (result === null) return res.status(404).json({ error: 'الإعلان غير موجود' });
  res.json({ success: true });
}

module.exports = { list, getById, create, update, remove };
