const BaseRepository = require('./_base');

class GradeRepository extends BaseRepository {
  constructor() {
    super('grades');
  }

  async findByStage(stage) {
    return this.query({ stage, deleted: false }, { orderBy: 'order' });
  }

  async findActive() {
    return this.query({ status: 'active', deleted: false }, { orderBy: 'order' });
  }
}

module.exports = GradeRepository;
