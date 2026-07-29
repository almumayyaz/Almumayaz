const BaseRepository = require('./_base');

class QuizRepository extends BaseRepository {
  constructor() {
    super('quizzes');
  }

  async findByEntity(entityType, entityId) {
    return this.query({ entityType, entityId, deleted: false });
  }

  async findCourseQuiz(courseId) {
    const quizzes = await this.query({ entityType: 'course', entityId: courseId, deleted: false });
    return quizzes[0] || null;
  }

  async findLessonQuiz(lessonId) {
    const quizzes = await this.query({ entityType: 'lesson', entityId: lessonId, deleted: false });
    return quizzes[0] || null;
  }
}

module.exports = QuizRepository;
