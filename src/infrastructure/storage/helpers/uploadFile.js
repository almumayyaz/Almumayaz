const { buildObjectKey, VALID_TYPES } = require('../ObjectKeyBuilder');
const { getPolicy } = require('../policies/StoragePolicy');

async function uploadFile(storage, { type, entityId, buffer, filename, extension, mime, field, uploadedBy } = {}) {
  const key = buildObjectKey({ type, entityId, filename, extension, field });

  const policy = getPolicy(type);

  const result = await storage.upload({
    key,
    body: buffer,
    contentType: mime || 'application/octet-stream',
    visibility: policy.visibility,
    metadata: {
      cacheControl: policy.cacheControl,
      contentDisposition: policy.contentDisposition,
      originalName: filename || 'file',
      type,
      entityId,
      uploadedBy: uploadedBy || 'system'
    }
  });

  return { objectKey: key, ...result };
}

module.exports = { uploadFile, VALID_TYPES };
