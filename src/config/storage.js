const VALID_PROVIDERS = ['legacy', 'r2'];

const config = {
  getProvider() {
    const provider = (process.env.STORAGE_PROVIDER || 'legacy').toLowerCase();
    if (!VALID_PROVIDERS.includes(provider)) {
      console.warn(`[storage-config] Unknown STORAGE_PROVIDER="${provider}", falling back to "legacy"`);
      return 'legacy';
    }
    return provider;
  },

  isR2Enabled() {
    return this.getProvider() === 'r2';
  },

  isLegacy() {
    return this.getProvider() === 'legacy';
  },

  getValidProviders() {
    return [...VALID_PROVIDERS];
  }
};

module.exports = config;
