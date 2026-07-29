const BaseRepository = require('./_base');

class SystemStatsRepository extends BaseRepository {
  constructor() {
    super('systemStats');
  }

  async getLatest() {
    const all = await this.query({}, { orderBy: 'createdAt', order: 'desc', limit: 1 });
    return all[0] || null;
  }

  async recordStat(data, userId) {
    return this.create({ ...data, recordedAt: new Date().toISOString() }, userId);
  }
}

module.exports = SystemStatsRepository;
