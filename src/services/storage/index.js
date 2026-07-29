const { StorageService } = require('./StorageService');
const { StorageProvider } = require('./StorageProvider');
const { CloudflareR2Provider } = require('./CloudflareR2Provider');
const { LegacyStorageAdapter } = require('./LegacyStorageAdapter');
const storageFactory = require('./StorageFactory');
const { DeleteStrategy, DirectDeleteStrategy } = require('../../infrastructure/storage/DeleteStrategy');

module.exports = {
  StorageService,
  StorageProvider,
  CloudflareR2Provider,
  LegacyStorageAdapter,
  ...storageFactory,
  DeleteStrategy,
  DirectDeleteStrategy
};
