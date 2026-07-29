const BaseRepository = require('./_base');

class NoteRepository extends BaseRepository {
  constructor() {
    super('studentNotes');
  }

  async findByUser(userId) {
    return this.query({ userId, deleted: false });
  }

  async findByUserAndLesson(userId, lessonId) {
    return this.query({ userId, lessonId, deleted: false });
  }
}

module.exports = NoteRepository;
