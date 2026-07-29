const BaseRepository = require('./_base');

class QuestionRepository extends BaseRepository {
  constructor() {
    super('questions');
  }

  async findByQuiz(quizId) {
    return this.query({ quizId, deleted: false }, { orderBy: 'order' });
  }

  async findActiveByQuiz(quizId) {
    return this.query({ quizId, status: 'active', deleted: false }, { orderBy: 'order' });
  }
}

module.exports = QuestionRepository;
