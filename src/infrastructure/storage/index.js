const { StorageService, generateChecksum } = require('./StorageService');
const { StorageProvider } = require('./providers/StorageProvider');
const { CloudflareR2Provider } = require('./providers/CloudflareR2Provider');
const { LegacyStorageAdapter } = require('./providers/LegacyStorageAdapter');
const storageFactory = require('./StorageFactory');
const { DeleteStrategy, DirectDeleteStrategy } = require('./DeleteStrategy');
const { buildObjectKey } = require('./ObjectKeyBuilder');
const { StorageEvents } = require('./StorageEvents');
const { StorageMetrics } = require('./StorageMetrics');
const { SignedUrlManager } = require('./SignedUrlManager');
const { DeleteManager } = require('./DeleteManager');
const { buildMetadata } = require('./MetadataBuilder');
const { validateUpload } = require('./UploadValidator');
const { getPolicy, isPublic, isPrivate, getSignedUrlExpiry, POLICIES, VALID_TYPES } = require('./policies/StoragePolicy');
const { uploadFile } = require('./helpers/uploadFile');
const { deleteFile, deleteFiles } = require('./helpers/deleteFile');
const { getSignedUrl, getSignedUrlWithExpiry } = require('./helpers/signedUrl');
const { getPublicUrl, getSignedUploadUrl } = require('./helpers/publicUrl');

module.exports = {
  StorageService,
  generateChecksum,
  StorageProvider,
  CloudflareR2Provider,
  LegacyStorageAdapter,
  ...storageFactory,
  DeleteStrategy,
  DirectDeleteStrategy,
  buildObjectKey,
  StorageEvents,
  StorageMetrics,
  SignedUrlManager,
  DeleteManager,
  buildMetadata,
  validateUpload,
  getPolicy,
  isPublic,
  isPrivate,
  getSignedUrlExpiry,
  POLICIES,
  POLICY_TYPES: VALID_TYPES,
  uploadFile,
  deleteFile,
  deleteFiles,
  getSignedUrl,
  getSignedUrlWithExpiry,
  getPublicUrl,
  getSignedUploadUrl
};
