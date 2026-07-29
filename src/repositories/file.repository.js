const BaseRepository = require('./_base');

class FileRepository extends BaseRepository {
  constructor() {
    super('lessonFiles');
  }

  async findByLesson(lessonId) {
    return this.query({ lessonId, deleted: false }, { orderBy: 'order' });
  }
}

module.exports = FileRepository;
