const { initStorage, shutdownStorage } = require('./storage');

let _initialized = false;
let _services = {};

async function bootstrap() {
  if (_initialized) return _services;

  console.log('[bootstrap] Starting...');

  const storage = await initStorage();
  _services.storage = storage;

  _initialized = true;
  console.log('[bootstrap] All services initialized.');
  return _services;
}

function getServices() {
  if (!_initialized) {
    throw new Error('Bootstrap not initialized. Call bootstrap() first.');
  }
  return _services;
}

function getStorage() {
  return getServices().storage;
}

async function shutdown() {
  if (!_initialized) return;
  console.log('[bootstrap] Shutting down...');
  await shutdownStorage();
  _initialized = false;
  _services = {};
  console.log('[bootstrap] Shutdown complete.');
}

module.exports = { bootstrap, getServices, getStorage, shutdown };
