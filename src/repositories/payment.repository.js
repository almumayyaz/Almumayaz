const BaseRepository = require('./_base');

class PaymentRepository extends BaseRepository {
  constructor() {
    super('payments');
  }

  async findByUser(userId) {
    return this.query({ userId, deleted: false }, { orderBy: 'date', order: 'desc' });
  }

  async findByDateRange(startDate, endDate) {
    const all = await this.query({ deleted: false });
    return all.filter(p => p.date >= startDate && p.date <= endDate);
  }

  async getTotalRevenue() {
    const all = await this.query({ deleted: false });
    return all.reduce((sum, p) => sum + (p.amount || 0), 0);
  }
}

module.exports = PaymentRepository;
