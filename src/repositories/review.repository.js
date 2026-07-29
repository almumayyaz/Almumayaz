const BaseRepository = require('./_base');

class ReviewRepository extends BaseRepository {
  constructor() {
    super('reviews');
  }

  async findActive(options) {
    return this.query({ status: 'active', deleted: false }, { orderBy: 'order', ...options });
  }

  async findByCourse(courseId) {
    return this.query({ courseId, deleted: false });
  }

  async findByStage(stage) {
    return this.query({ stage, deleted: false }, { orderBy: 'order' });
  }
}

module.exports = ReviewRepository;
