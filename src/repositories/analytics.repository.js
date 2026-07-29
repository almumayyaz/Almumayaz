const BaseRepository = require('./_base');

class AnalyticsRepository extends BaseRepository {
  constructor() {
    super('analytics');
  }

  async getByDateRange(startDate, endDate) {
    const all = await this.query({ deleted: false });
    return all.filter(a => a.date >= startDate && a.date <= endDate);
  }

  async getLatest() {
    const all = await this.query({ deleted: false }, { orderBy: 'createdAt', order: 'desc', limit: 1 });
    return all[0] || null;
  }
}

module.exports = AnalyticsRepository;
