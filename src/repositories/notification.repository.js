const BaseRepository = require('./_base');

class NotificationRepository extends BaseRepository {
  constructor() {
    super('notifications');
  }

  async findRecent(limit = 50) {
    return this.query({ deleted: false }, { orderBy: 'sentAt', order: 'desc', limit });
  }

  async findByTarget(target) {
    return this.query({ target, deleted: false }, { orderBy: 'sentAt', order: 'desc' });
  }

  async findByTargetAndValue(target, targetValue) {
    return this.query({ target, targetValue, deleted: false }, { orderBy: 'sentAt', order: 'desc' });
  }

  async findBySource(source) {
    return this.query({ source, deleted: false }, { orderBy: 'sentAt', order: 'desc' });
  }
}

module.exports = NotificationRepository;
