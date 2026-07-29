const BaseRepository = require('./_base');

class ExamAttemptRepository extends BaseRepository {
  constructor() {
    super('studentExamAttempts');
  }

  async findByUser(userId) {
    return this.query({ userId, deleted: false }, { orderBy: 'completedAt', order: 'desc' });
  }

  async findByUserAndQuiz(userId, quizId) {
    return this.query({ userId, quizId, deleted: false }, { orderBy: 'attemptNumber', order: 'desc' });
  }

  async getLatestAttempt(userId, quizId) {
    const attempts = await this.findByUserAndQuiz(userId, quizId);
    return attempts[0] || null;
  }

  async getAttemptCount(userId, quizId) {
    const attempts = await this.query({ userId, quizId, deleted: false });
    return attempts.length;
  }

  async findPassedByUser(userId) {
    return this.query({ userId, passed: true, deleted: false });
  }
}

module.exports = ExamAttemptRepository;
