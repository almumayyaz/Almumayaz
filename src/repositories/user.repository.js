const BaseRepository = require('./_base');

class UserRepository extends BaseRepository {
  constructor() {
    super('users');
  }

  async findByEmail(email) {
    const users = await this.query({ email });
    return users[0] || null;
  }

  async findByRole(role, options) {
    return this.query({ role, deleted: false }, options);
  }

  async findByGradeAndStage(grade, stage) {
    return this.query({ grade, stage, deleted: false });
  }

  async findActiveByRole(role, options) {
    return this.query({ role, status: 'active', deleted: false }, options);
  }

  async findWithFcmToken() {
    const all = await this.query({ deleted: false });
    return all.filter(u => u.fcmToken);
  }

  async updateLastLogin(id) {
    return this.update(id, { lastLogin: new Date().toISOString() });
  }

  async findStudentsByGrade(grade) {
    return this.query({ role: 'student', grade, deleted: false });
  }

  async findStudentsByStage(stage) {
    return this.query({ role: 'student', stage, deleted: false });
  }
}

module.exports = UserRepository;
