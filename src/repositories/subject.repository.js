const BaseRepository = require('./_base');

class SubjectRepository extends BaseRepository {
  constructor() {
    super('subjects');
  }

  async findActive() {
    return this.query({ status: 'active', deleted: false }, { orderBy: 'order' });
  }

  async findByGrade(grade) {
    return this.query({ grade, deleted: false }, { orderBy: 'order' });
  }
}

module.exports = SubjectRepository;
