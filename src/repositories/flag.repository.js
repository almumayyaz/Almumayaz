const BaseRepository = require('./_base');

class FlagRepository extends BaseRepository {
  constructor() {
    super('featureFlags');
  }

  async isEnabled(flagName) {
    const flag = await this.get(flagName);
    return flag ? flag.enabled === true : false;
  }

  async getAllFlags() {
    return this.query({ deleted: false });
  }
}

module.exports = FlagRepository;
