const { announcementRepo } = require('../repositories');

async function listAnnouncements() {
  return announcementRepo.query({}, { orderBy: { createdAt: 'desc' } });
}

async function getAnnouncement(id) {
  const ann = await announcementRepo.get(id);
  if (!ann || ann.deletedAt) return null;
  return ann;
}

async function createAnnouncement(data) {
  return announcementRepo.create({
    title: data.title || 'إعلان جديد',
    content: data.content || '',
    important: data.important || false,
  });
}

async function updateAnnouncement(id, body) {
  const existing = await announcementRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  const allowed = ['title', 'content', 'important', 'active'];
  const data = {};
  for (const field of allowed) {
    if (body[field] !== undefined) data[field] = body[field];
  }
  return announcementRepo.update(id, data);
}

async function deleteAnnouncement(id, actor) {
  const existing = await announcementRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  await announcementRepo.softDelete(id, actor);
}

module.exports = { listAnnouncements, getAnnouncement, createAnnouncement, updateAnnouncement, deleteAnnouncement };
