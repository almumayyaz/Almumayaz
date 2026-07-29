const storageConfig = require('../config/storage');
const { getStorageService, resetInstance } = require('../infrastructure/storage/StorageFactory');

let _service = null;

async function initStorage() {
  if (_service) return _service;

  _service = getStorageService();

  if (storageConfig.isR2Enabled()) {
    console.log('[bootstrap] Running R2 health check...');
    const health = await _service.healthCheck();
    if (!health.ok) {
      console.error('[bootstrap] R2 health check FAILED:', health.error);
      console.error('[bootstrap] Check R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET env vars.');
      console.error('[bootstrap] Set STORAGE_PROVIDER=legacy to use Supabase storage instead.');
      process.exit(1);
    }
    console.log('[bootstrap] R2 storage initialized successfully.');
  } else {
    const providerName = _service.getProviderName();
    console.log(`[bootstrap] Storage initialized: ${providerName} (health check skipped in legacy mode)`);
  }

  return _service;
}

function getStorage() {
  if (!_service) {
    throw new Error('Storage not initialized. Call initStorage() first.');
  }
  return _service;
}

async function shutdownStorage() {
  if (_service) {
    resetInstance();
    _service = null;
    console.log('[bootstrap] Storage shut down.');
  }
}

module.exports = { initStorage, getStorage, shutdownStorage };
