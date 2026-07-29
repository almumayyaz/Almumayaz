const { ticketRepo } = require('../repositories');

async function listTickets({ status } = {}) {
  const where = {};
  if (status) where.status = status;
  return ticketRepo.query(where, { orderBy: { createdAt: 'desc' } });
}

async function getTicket(id) {
  const ticket = await ticketRepo.get(id);
  if (!ticket || ticket.deletedAt) return null;
  return ticket;
}

async function createTicket(uid, { name, email, phone, subject, message }) {
  return ticketRepo.create({
    userId: uid || '',
    subject: subject || '',
    message: message || '',
    status: 'open',
  });
}

async function updateTicket(id, body) {
  const existing = await ticketRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  const allowed = ['subject', 'message', 'status'];
  const data = {};
  for (const field of allowed) {
    if (body[field] !== undefined) data[field] = body[field];
  }
  return ticketRepo.update(id, data);
}

async function closeTicket(id) {
  const existing = await ticketRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  return ticketRepo.update(id, { status: 'closed' });
}

async function deleteTicket(id, actor) {
  const existing = await ticketRepo.get(id);
  if (!existing || existing.deletedAt) return null;
  await ticketRepo.softDelete(id, actor);
}

module.exports = { listTickets, getTicket, createTicket, updateTicket, closeTicket, deleteTicket };
