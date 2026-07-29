const BaseRepository = require('./_base');

class LessonProgressRepository extends BaseRepository {
  constructor() {
    super('studentLessonProgress');
  }

  async findByUserAndCourse(userId, courseId) {
    return this.query({ userId, courseId, deleted: false });
  }

  async findByUserAndLesson(userId, lessonId) {
    const progress = await this.query({ userId, lessonId, deleted: false });
    return progress[0] || null;
  }

  async findCompletedByCourse(userId, courseId) {
    return this.query({ userId, courseId, status: 'completed', deleted: false });
  }

  async getCompletedCount(userId, courseId) {
    const completed = await this.findCompletedByCourse(userId, courseId);
    return completed.length;
  }
}

module.exports = LessonProgressRepository;
