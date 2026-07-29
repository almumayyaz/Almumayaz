async function getPublicUrl(storage, objectKey) {
  return storage.createPublicUrl(objectKey);
}

async function getSignedUploadUrl(storage, objectKey, contentType) {
  return storage.createSignedUploadUrl(objectKey, contentType);
}

module.exports = { getPublicUrl, getSignedUploadUrl };
