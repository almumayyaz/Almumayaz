class DeleteManager {
  constructor(storageService) {
    this._storage = storageService;
  }

  async delete(objectKey) {
    return this._storage.delete(objectKey);
  }

  async deleteMany(objectKeys) {
    const results = [];
    for (const key of objectKeys) {
      try {
        const result = await this._storage.delete(key);
        results.push({ objectKey: key, success: result });
      } catch (e) {
        results.push({ objectKey: key, success: false, error: e.message });
      }
    }
    return results;
  }
}

module.exports = { DeleteManager };
