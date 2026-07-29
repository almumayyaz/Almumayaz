const BaseRepository = require('./_base');

class AnnouncementRepository extends BaseRepository {
  constructor() {
    super('announcements');
  }

  async findRecent(limit = 20) {
    return this.query({ deleted: false }, { orderBy: 'date', order: 'desc', limit });
  }

  async findImportant() {
    return this.query({ important: true, deleted: false }, { orderBy: 'date', order: 'desc' });
  }
}

module.exports = AnnouncementRepository;
