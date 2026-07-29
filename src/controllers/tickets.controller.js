const { ticketService } = require('../services');

function actorId(req) {
  return req.user?.id || req.session?.user?.id;
}

async function list(req, res) {
  const tickets = await ticketService.listTickets(req.query);
  res.json(tickets);
}

async function getById(req, res) {
  const ticket = await ticketService.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'التذكرة غير موجودة' });
  res.json(ticket);
}

async function create(req, res) {
  const ticket = await ticketService.createTicket(actorId(req), req.body);
  res.status(201).json({ success: true, ticket });
}

async function update(req, res) {
  const updated = await ticketService.updateTicket(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'التذكرة غير موجودة' });
  res.json({ success: true, ticket: updated });
}

async function close(req, res) {
  const updated = await ticketService.closeTicket(req.params.id);
  if (!updated) return res.status(404).json({ error: 'التذكرة غير موجودة' });
  res.json({ success: true, ticket: updated });
}

async function remove(req, res) {
  const result = await ticketService.deleteTicket(req.params.id, actorId(req));
  if (result === null) return res.status(404).json({ error: 'التذكرة غير موجودة' });
  res.json({ success: true });
}

module.exports = { list, getById, create, update, close, remove };
