const { getSignedUrlExpiry, isPublic } = require('./policies/StoragePolicy');

class SignedUrlManager {
  constructor(storageService) {
    this._storage = storageService;
  }

  async generate(objectKey, type) {
    if (isPublic(type)) {
      return this._storage.createPublicUrl(objectKey);
    }
    const expiry = getSignedUrlExpiry(type);
    return this._storage.createSignedUrl(objectKey, expiry);
  }

  async generateWithExpiry(objectKey, customExpiry) {
    return this._storage.createSignedUrl(objectKey, customExpiry);
  }

  async generateUploadUrl(objectKey, contentType) {
    return this._storage.createSignedUploadUrl(objectKey, contentType);
  }
}

module.exports = { SignedUrlManager };
