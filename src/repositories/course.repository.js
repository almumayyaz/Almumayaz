const BaseRepository = require('./_base');

class CourseRepository extends BaseRepository {
  constructor() {
    super('courses');
  }

  async findActive(options) {
    return this.query({ status: 'active', deleted: false }, { orderBy: 'order', ...options });
  }

  async findByGrade(grade, options) {
    return this.query({ grade, deleted: false }, { orderBy: 'order', ...options });
  }

  async findByStage(stage, options) {
    return this.query({ stage, deleted: false }, { orderBy: 'order', ...options });
  }

  async findBySemester(semester) {
    return this.query({ semester, deleted: false });
  }

  async findByStageAndGrade(stage, grade) {
    return this.query({ stage, grade, deleted: false }, { orderBy: 'order' });
  }
}

module.exports = CourseRepository;
