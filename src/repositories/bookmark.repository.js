const BaseRepository = require('./_base');

class BookmarkRepository extends BaseRepository {
  constructor() {
    super('studentBookmarks');
  }

  async findByUser(userId) {
    return this.query({ userId, deleted: false });
  }

  async findByUserAndLesson(userId, lessonId) {
    const bookmarks = await this.query({ userId, lessonId, deleted: false });
    return bookmarks[0] || null;
  }

  async isBookmarked(userId, lessonId) {
    const b = await this.findByUserAndLesson(userId, lessonId);
    return !!b;
  }
}

module.exports = BookmarkRepository;
