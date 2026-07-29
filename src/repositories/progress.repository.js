const BaseRepository = require('./_base');

class ProgressRepository extends BaseRepository {
  constructor() {
    super('studentProgress');
  }

  async findByUser(userId) {
    return this.query({ userId, deleted: false });
  }

  async findByUserAndCourse(userId, courseId) {
    const progress = await this.query({ userId, courseId, deleted: false });
    return progress[0] || null;
  }

  async getCompletionPercentage(userId, courseId) {
    const p = await this.findByUserAndCourse(userId, courseId);
    return p ? p.percentage : 0;
  }
}

module.exports = ProgressRepository;
