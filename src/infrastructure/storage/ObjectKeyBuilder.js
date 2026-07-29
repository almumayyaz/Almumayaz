const crypto = require('crypto');

const BUILDERS = {
  avatar(e) {
    return `avatars/${e.entityId}/avatar-${crypto.randomUUID()}.${e.extension}`;
  },
  lessonPdf(e) {
    return `lessons/${e.entityId}/${e.field || 'pdf'}-${crypto.randomUUID()}.${e.extension || 'pdf'}`;
  },
  reviewPdf(e) {
    return `reviews/${e.entityId}/${e.field || 'pdf'}-${crypto.randomUUID()}.${e.extension || 'pdf'}`;
  },
  noteFile(e) {
    const safe = (e.filename || 'file').replace(/[^\w.\-]/g, '_').slice(0, 60);
    return `notes/${e.entityId}/${crypto.randomUUID()}-${safe}`;
  },
  chatImage(e) {
    return `chats/${e.entityId}/${crypto.randomUUID()}.${e.extension || 'png'}`;
  },
  paymentReceipt(e) {
    return `payments/${e.entityId}/receipt-${crypto.randomUUID()}.${e.extension || 'jpg'}`;
  },
  subrequestReceipt(e) {
    return `subrequests/${e.entityId}/receipt-${crypto.randomUUID()}.${e.extension || 'jpg'}`;
  },
  font(e) {
    return `fonts/${e.filename || 'font'}-${crypto.randomUUID()}.${e.extension || 'woff2'}`;
  },
  chatAttachment(e) {
    return `chat-attachments/${e.entityId}/${crypto.randomUUID()}.${e.extension || 'pdf'}`;
  }
};

const VALID_TYPES = Object.keys(BUILDERS);

function buildObjectKey({ type, entityId, filename, extension, field } = {}) {
  if (!type) throw new Error('buildObjectKey requires a type');
  if (!entityId) throw new Error('buildObjectKey requires an entityId');

  const builder = BUILDERS[type];
  if (!builder) {
    throw new Error(`Unknown object key type: "${type}". Valid types: ${VALID_TYPES.join(', ')}`);
  }

  const ext = (extension || '').replace(/^\./, '').toLowerCase();
  return builder({ type, entityId, filename, extension: ext || 'bin', field: field || 'file' });
}

module.exports = { buildObjectKey, VALID_TYPES };
