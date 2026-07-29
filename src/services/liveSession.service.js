const repos = require('../repositories');
const { BaseService, ValidationError } = require('./_base');

class LiveSessionService extends BaseService {
  constructor() {
    super(new (require('../repositories/_base'))('liveSessions'));
  }

  async getUpcoming() {
    return this.list({ status: 'Scheduled' }, { orderBy: 'startTime', order: 'asc' });
  }

  async getLive() {
    return this.list({ status: 'Live' }, { orderBy: 'startTime', order: 'desc' });
  }

  async getEnded(limit = 20) {
    return this.list({ status: 'Ended' }, { orderBy: 'startTime', order: 'desc', limit });
  }

  async startSession(sessionId) {
    return this.update(sessionId, { status: 'Live' });
  }

  async endSession(sessionId) {
    return this.update(sessionId, { status: 'Ended' });
  }

  async toggleRecording(sessionId, enabled) {
    return this.update(sessionId, { recording: enabled });
  }
}

module.exports = new LiveSessionService();
