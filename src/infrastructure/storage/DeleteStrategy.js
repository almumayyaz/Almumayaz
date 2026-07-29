class DeleteStrategy {
  async delete(objectKey) {
    throw new Error('Not implemented');
  }
}

class DirectDeleteStrategy extends DeleteStrategy {
  constructor(provider) {
    super();
    this._provider = provider;
  }

  async delete(objectKey) {
    return this._provider.delete(objectKey);
  }
}

module.exports = { DeleteStrategy, DirectDeleteStrategy };
