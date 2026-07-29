const BaseRepository = require('./_base');

class EnrollmentRepository extends BaseRepository {
  constructor() {
    super('enrollments');
  }

  async findByUser(userId) {
    return this.query({ userId, deleted: false });
  }

  async findActiveByUser(userId) {
    return this.query({ userId, status: 'active', deleted: false });
  }

  async findByCourse(courseId) {
    return this.query({ courseId, deleted: false });
  }

  async findActiveByCourse(courseId) {
    return this.query({ courseId, status: 'active', deleted: false });
  }

  async findByUserAndCourse(userId, courseId) {
    const enrollments = await this.query({ userId, courseId, deleted: false });
    return enrollments[0] || null;
  }

  async isEnrolled(userId, courseId) {
    const enrollment = await this.findByUserAndCourse(userId, courseId);
    return enrollment && enrollment.status === 'active';
  }
}

module.exports = EnrollmentRepository;
