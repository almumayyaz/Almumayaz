const crypto = require('crypto');

function generateChecksum(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildMetadata({ buffer, originalName, mime, type, entityId, uploadedBy } = {}) {
  const metadata = {
    uploadedAt: new Date().toISOString(),
    size: buffer ? buffer.length : 0,
    checksum: buffer ? generateChecksum(buffer) : '',
  };

  if (originalName) metadata.originalName = originalName;
  if (mime) metadata.mime = mime;
  if (type) metadata.type = type;
  if (entityId) metadata.entityId = entityId;
  if (uploadedBy) metadata.uploadedBy = uploadedBy;

  return metadata;
}

module.exports = { buildMetadata, generateChecksum };
