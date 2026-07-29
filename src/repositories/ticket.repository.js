const BaseRepository = require('./_base');

class TicketRepository extends BaseRepository {
  constructor() {
    super('supportTickets');
  }

  async findByUser(userId) {
    return this.query({ userId, deleted: false }, { orderBy: 'createdAt', order: 'desc' });
  }

  async findOpen() {
    return this.query({ status: 'open', deleted: false }, { orderBy: 'createdAt', order: 'desc' });
  }

  async findClosed() {
    return this.query({ status: 'closed', deleted: false }, { orderBy: 'createdAt', order: 'desc' });
  }
}

module.exports = TicketRepository;
