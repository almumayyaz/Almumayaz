const BaseRepository = require('./_base');

class ChargeCodeRepository extends BaseRepository {
  constructor() {
    super('chargeCodes');
  }

  async findByCode(code) {
    const codes = await this.query({ code, deleted: false });
    return codes[0] || null;
  }

  async findActive() {
    return this.query({ active: true, deleted: false });
  }

  async redeem(codeId, userId) {
    const code = await this.get(codeId);
    if (!code) throw new Error('Code not found');
    if (!code.active) throw new Error('Code is inactive');
    if (code.maxUses && code.usedCount >= code.maxUses) throw new Error('Code has expired uses');

    return this.update(codeId, {
      usedCount: (code.usedCount || 0) + 1,
      usedBy: [...(code.usedBy || []), userId]
    });
  }
}

module.exports = ChargeCodeRepository;
