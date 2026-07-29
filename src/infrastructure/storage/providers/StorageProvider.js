class StorageProvider {
  getProviderName() {
    return 'abstract';
  }

  async upload({ key, body, contentType, metadata, visibility }) {
    throw new Error('Not implemented');
  }

  async delete(objectKey) {
    throw new Error('Not implemented');
  }

  async exists(objectKey) {
    throw new Error('Not implemented');
  }

  async createSignedUrl(objectKey, ttlSecs) {
    throw new Error('Not implemented');
  }

  async createPublicUrl(objectKey) {
    throw new Error('Not implemented');
  }

  async getObject(objectKey) {
    throw new Error('Not implemented');
  }

  async listObjects(prefix) {
    throw new Error('Not implemented');
  }

  async createSignedUploadUrl(objectKey, contentType) {
    throw new Error('Not implemented');
  }

  async copy(sourceKey, destKey) {
    throw new Error('Not implemented');
  }

  getBucket() {
    throw new Error('Not implemented');
  }
}

module.exports = { StorageProvider };
