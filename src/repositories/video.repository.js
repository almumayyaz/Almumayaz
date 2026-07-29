const BaseRepository = require('./_base');

class VideoRepository extends BaseRepository {
  constructor() {
    super('lessonVideos');
  }

  async findByLesson(lessonId) {
    return this.query({ lessonId, deleted: false }, { orderBy: 'order' });
  }

  async findByLessonActive(lessonId) {
    return this.query({ lessonId, status: 'active', deleted: false }, { orderBy: 'order' });
  }
}

module.exports = VideoRepository;
