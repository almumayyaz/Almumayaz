const BaseRepository = require('./_base');

class SubscriptionRepository extends BaseRepository {
  constructor() {
    super('subscriptions');
  }

  async findActive() {
    return this.query({ status: 'active', deleted: false });
  }

  async findByStage(stage) {
    return this.query({ stage, deleted: false });
  }
}

module.exports = SubscriptionRepository;
