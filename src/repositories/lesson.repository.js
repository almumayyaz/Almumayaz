const BaseRepository = require('./_base');

class LessonRepository extends BaseRepository {
  constructor() {
    super('lessons');
  }

  async findByCourse(courseId) {
    return this.query({ courseId, deleted: false }, { orderBy: 'order' });
  }

  async findByUnit(unitId) {
    return this.query({ unitId, deleted: false }, { orderBy: 'order' });
  }

  async findByCourseAndUnit(courseId, unitId) {
    return this.query({ courseId, unitId, deleted: false }, { orderBy: 'order' });
  }

  async findActiveByCourse(courseId) {
    return this.query({ courseId, status: 'active', deleted: false }, { orderBy: 'order' });
  }

  async findFree() {
    return this.query({ isFree: true, deleted: false });
  }
}

module.exports = LessonRepository;
