const BaseRepository = require('./_base');

class ReceiptRepository extends BaseRepository {
  constructor() {
    super('paymentReceipts');
  }

  async findByUser(userId) {
    return this.query({ userId, deleted: false }, { orderBy: 'createdAt', order: 'desc' });
  }

  async findPending() {
    return this.query({ status: 'pending', deleted: false });
  }
}

module.exports = ReceiptRepository;
