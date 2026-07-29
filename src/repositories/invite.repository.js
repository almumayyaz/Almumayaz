const BaseRepository = require('./_base');

class InviteRepository extends BaseRepository {
  constructor() {
    super('parentInvites');
  }

  async findByToken(token) {
    const invites = await this.query({ token, deleted: false });
    return invites[0] || null;
  }

  async findByStudent(studentId) {
    return this.query({ studentId, deleted: false });
  }

  async findPending() {
    return this.query({ status: 'pending', deleted: false });
  }

  async accept(token) {
    const invite = await this.findByToken(token);
    if (!invite) throw new Error('Invite not found');
    return this.update(invite.id, { status: 'accepted' });
  }
}

module.exports = InviteRepository;
