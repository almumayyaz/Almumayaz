const BaseRepository = require('./_base');

class ActivityLogRepository extends BaseRepository {
  constructor() {
    super('activityLogs');
  }

  async findByUser(userId) {
    return this.query({ userId, deleted: false }, { orderBy: 'createdAt', order: 'desc' });
  }

  async findByAction(action) {
    return this.query({ action, deleted: false }, { orderBy: 'createdAt', order: 'desc' });
  }

  async findRecent(limit = 100) {
    return this.query({ deleted: false }, { orderBy: 'createdAt', order: 'desc', limit });
  }
}

module.exports = ActivityLogRepository;
