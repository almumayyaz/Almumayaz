const BaseRepository = require('./_base');

class UnitRepository extends BaseRepository {
  constructor() {
    super('units');
  }

  async findByCourse(courseId) {
    return this.query({ courseId, deleted: false }, { orderBy: 'order' });
  }

  async findActiveByCourse(courseId) {
    return this.query({ courseId, status: 'active', deleted: false }, { orderBy: 'order' });
  }
}

module.exports = UnitRepository;
