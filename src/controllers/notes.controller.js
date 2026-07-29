const { noteService } = require('../services');

function actorId(req) {
  return req.user?.id || req.session?.user?.id;
}

async function list(req, res) {
  const notes = await noteService.listNotes(req.query);
  res.json(notes);
}

async function getById(req, res) {
  const note = await noteService.getNote(req.params.id);
  if (!note) return res.status(404).json({ error: 'المذكرة غير موجودة' });
  res.json(note);
}

async function create(req, res) {
  const note = await noteService.createNote(req.body);
  res.status(201).json({ success: true, note });
}

async function update(req, res) {
  const updated = await noteService.updateNote(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'المذكرة غير موجودة' });
  res.json({ success: true, note: updated });
}

async function remove(req, res) {
  const result = await noteService.deleteNote(req.params.id, actorId(req));
  if (result === null) return res.status(404).json({ error: 'المذكرة غير موجودة' });
  res.json({ success: true });
}

module.exports = { list, getById, create, update, remove };
