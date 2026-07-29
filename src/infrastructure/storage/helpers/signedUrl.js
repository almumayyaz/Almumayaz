const { getSignedUrlExpiry, isPublic } = require('../policies/StoragePolicy');

async function getSignedUrl(storage, objectKey, type) {
  if (isPublic(type)) {
    return storage.createPublicUrl(objectKey);
  }
  const expiry = getSignedUrlExpiry(type);
  return storage.createSignedUrl(objectKey, expiry);
}

async function getSignedUrlWithExpiry(storage, objectKey, customExpiry) {
  return storage.createSignedUrl(objectKey, customExpiry);
}

module.exports = { getSignedUrl, getSignedUrlWithExpiry };
