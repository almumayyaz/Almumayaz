const BaseRepository = require('./_base');

class QuestionBankRepository extends BaseRepository {
  constructor() {
    super('questionBanks');
  }

  async findByCourse(courseId) {
    return this.query({ courseId, deleted: false });
  }

  async findByStage(stage) {
    return this.query({ stage, deleted: false });
  }

  async findByGrade(grade) {
    return this.query({ grade, deleted: false });
  }
}

module.exports = QuestionBankRepository;
