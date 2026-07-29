const POLICIES = {
  avatar: {
    visibility: 'public',
    cacheControl: 'public, max-age=31536000, immutable',
    signedUrlExpiry: null,
    contentDisposition: 'inline'
  },
  lessonPdf: {
    visibility: 'private',
    cacheControl: 'private, max-age=0, must-revalidate',
    signedUrlExpiry: 60,
    contentDisposition: 'inline'
  },
  reviewPdf: {
    visibility: 'private',
    cacheControl: 'private, max-age=0, must-revalidate',
    signedUrlExpiry: 60,
    contentDisposition: 'inline'
  },
  noteFile: {
    visibility: 'private',
    cacheControl: 'private, max-age=0, must-revalidate',
    signedUrlExpiry: 300,
    contentDisposition: 'inline'
  },
  chatImage: {
    visibility: 'private',
    cacheControl: 'private, no-cache',
    signedUrlExpiry: 3600,
    contentDisposition: 'inline'
  },
  paymentReceipt: {
    visibility: 'private',
    cacheControl: 'private, no-cache',
    signedUrlExpiry: 300,
    contentDisposition: 'inline'
  },
  subrequestReceipt: {
    visibility: 'private',
    cacheControl: 'private, no-cache',
    signedUrlExpiry: 300,
    contentDisposition: 'inline'
  },
  font: {
    visibility: 'public',
    cacheControl: 'public, max-age=31536000, immutable',
    signedUrlExpiry: null,
    contentDisposition: 'inline'
  },
  chatAttachment: {
    visibility: 'private',
    cacheControl: 'private, no-cache',
    signedUrlExpiry: 3600,
    contentDisposition: 'inline'
  }
};

const VALID_TYPES = Object.keys(POLICIES);

function getPolicy(type) {
  if (!POLICIES[type]) {
    throw new Error(`Unknown storage policy type: "${type}". Valid types: ${VALID_TYPES.join(', ')}`);
  }
  return { ...POLICIES[type] };
}

function getSignedUrlExpiry(type) {
  const policy = getPolicy(type);
  if (policy.signedUrlExpiry === null) {
    throw new Error(`Policy "${type}" is public and does not support signed URLs. Use public URL instead.`);
  }
  return policy.signedUrlExpiry;
}

function isPublic(type) {
  return getPolicy(type).visibility === 'public';
}

function isPrivate(type) {
  return getPolicy(type).visibility === 'private';
}

module.exports = { getPolicy, getSignedUrlExpiry, isPublic, isPrivate, POLICIES, VALID_TYPES };
