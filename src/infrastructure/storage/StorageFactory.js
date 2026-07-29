const storageConfig = require('../../config/storage');
const { StorageService } = require('./StorageService');
const { CloudflareR2Provider } = require('./providers/CloudflareR2Provider');
const { LegacyStorageAdapter } = require('./providers/LegacyStorageAdapter');
const { DirectDeleteStrategy } = require('./DeleteStrategy');

let _instance = null;

function resetInstance() {
  _instance = null;
}

function getStorageService() {
  if (_instance) return _instance;

  let provider;
  if (storageConfig.isR2Enabled()) {
    provider = new CloudflareR2Provider();
  } else {
    provider = new LegacyStorageAdapter();
  }

  const deleteStrategy = new DirectDeleteStrategy(provider);
  _instance = new StorageService(provider, deleteStrategy);
  return _instance;
}

function getStorageProvider() {
  return getStorageService().getProvider();
}

module.exports = { getStorageService, getStorageProvider, resetInstance };
