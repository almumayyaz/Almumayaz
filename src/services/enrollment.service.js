const repos = require('../repositories');
const { BaseService, NotFoundError, ValidationError, ConflictError } = require('./_base');

class EnrollmentService extends BaseService {
  constructor() {
    super(repos.EnrollmentRepository);
    this.courseRepo = repos.CourseRepository;
    this.userRepo = repos.UserRepository;
    this.paymentRepo = repos.PaymentRepository;
    this.progressRepo = repos.ProgressRepository;
  }

  async enroll(userId, courseId, metadata = {}) {
    const existing = await this.repo.findByUserAndCourse(userId, courseId);
    if (existing && existing.status === 'active') {
      throw new ConflictError('User is already enrolled in this course');
    }

    const enrollment = await this.create({
      userId,
      courseId,
      enrolledAt: Date.now(),
      status: 'active',
      ...metadata,
    }, userId);

    await this.progressRepo.create({
      userId,
      courseId,
      percentage: 0,
      completedLessons: [],
      completedQuizzes: [],
      lastAccess: Date.now(),
    }, userId);

    return enrollment;
  }

  async unenroll(userId, courseId) {
    const enrollment = await this.repo.findByUserAndCourse(userId, courseId);
    if (!enrollment) throw new NotFoundError('Enrollment not found');

    return this.delete(enrollment.id, userId);
  }

  async checkAccess(userId, courseId) {
    const enrollment = await this.repo.findByUserAndCourse(userId, courseId);
    return enrollment && enrollment.status === 'active';
  }

  async getEnrolledCourses(userId) {
    return this.repo.findByUser(userId);
  }

  async getEnrolledStudents(courseId) {
    return this.repo.findByCourse(courseId);
  }

  async getActiveEnrollments(userId) {
    return this.repo.findActiveByUser(userId);
  }

  async bulkEnroll(userIds, courseId) {
    const results = [];
    for (const userId of userIds) {
      try {
        const enrollment = await this.enroll(userId, courseId);
        results.push({ userId, status: 'ok', enrollment });
      } catch (err) {
        results.push({ userId, status: 'error', error: err.message });
      }
    }
    return results;
  }
}

module.exports = new EnrollmentService();
