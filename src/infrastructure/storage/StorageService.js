const { StorageProvider } = require('./providers/StorageProvider');
const { DeleteStrategy } = require('./DeleteStrategy');
const { StorageEvents } = require('./StorageEvents');
const { StorageMetrics } = require('./StorageMetrics');
const { validateUpload } = require('./UploadValidator');
const { buildMetadata, generateChecksum } = require('./MetadataBuilder');
const path = require('path');
const crypto = require('crypto');

class StorageService {
  constructor(provider, deleteStrategy) {
    if (!(provider instanceof StorageProvider)) {
      throw new Error('StorageService requires a StorageProvider instance');
    }
    this._provider = provider;
    this._bucket = provider.getBucket();
    this._deleteStrategy = deleteStrategy || null;
    this._events = new StorageEvents();
    this._metrics = new StorageMetrics();
  }

  getProvider() {
    return this._provider;
  }

  getBucket() {
    return this._bucket;
  }

  getProviderName() {
    return this._provider.getProviderName();
  }

  getEvents() {
    return this._events;
  }

  getMetrics() {
    return this._metrics;
  }

  setDeleteStrategy(strategy) {
    if (!(strategy instanceof DeleteStrategy)) {
      throw new Error('StorageService requires a DeleteStrategy instance');
    }
    this._deleteStrategy = strategy;
  }

  generateObjectKey(model, id, field, originalName) {
    const ext = path.extname(originalName || '') || '';
    const uuid = crypto.randomUUID();
    const safe = (originalName || 'file')
      .replace(/\.[^/.]+$/, '')
      .replace(/[^\w.\-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'file';
    return `${model}/${id}/${field}-${uuid}${ext}`;
  }

  async upload({ key, body, visibility = 'private', metadata = {}, contentType } = {}) {
    if (!key) throw new Error('upload requires a key');
    if (!body) throw new Error('upload requires a body');

    const start = Date.now();

    try {
      await this._events.emit('beforeUpload', { key, visibility, contentType });

      const fullMetadata = buildMetadata({
        buffer: body,
        originalName: metadata.originalName,
        mime: contentType,
        type: metadata.type,
        entityId: metadata.entityId,
        uploadedBy: metadata.uploadedBy
      });
      const merged = { ...fullMetadata, ...metadata };

      const result = await this._provider.upload({
        key,
        body,
        contentType: contentType || 'application/octet-stream',
        visibility,
        metadata: merged
      });

      this._metrics.recordUpload(Date.now() - start, body.length);
      await this._events.emit('afterUpload', { key, result });

      return result;
    } catch (e) {
      this._metrics.recordFailedUpload();
      await this._events.emit('uploadFailed', { key, error: e.message });
      throw e;
    }
  }

  async delete(objectKey) {
    const start = Date.now();

    try {
      await this._events.emit('beforeDelete', { objectKey });

      let result;
      if (this._deleteStrategy) {
        result = await this._deleteStrategy.delete(objectKey);
      } else {
        result = await this._provider.delete(objectKey);
      }

      this._metrics.recordDelete(Date.now() - start, 0);
      await this._events.emit('afterDelete', { objectKey, result });

      return result;
    } catch (e) {
      this._metrics.recordFailedDelete();
      await this._events.emit('deleteFailed', { objectKey, error: e.message });
      throw e;
    }
  }

  async exists(objectKey) {
    return this._provider.exists(objectKey);
  }

  async createSignedUrl(objectKey, ttlSecs) {
    return this._provider.createSignedUrl(objectKey, ttlSecs);
  }

  async createPublicUrl(objectKey) {
    return this._provider.createPublicUrl(objectKey);
  }

  async getObject(objectKey) {
    return this._provider.getObject(objectKey);
  }

  async listObjects(prefix) {
    return this._provider.listObjects(prefix);
  }

  async createSignedUploadUrl(objectKey, contentType) {
    return this._provider.createSignedUploadUrl(objectKey, contentType);
  }

  async copy(sourceKey, destKey) {
    return this._provider.copy(sourceKey, destKey);
  }

  async healthCheck() {
    try {
      const tmpKey = `_health_${Date.now()}.tmp`;
      await this._provider.upload({
        key: tmpKey,
        body: Buffer.from('ok'),
        contentType: 'text/plain',
        visibility: 'private',
        metadata: { purpose: 'health-check' }
      });
      await this._provider.delete(tmpKey);
      return { ok: true, provider: this._provider.getProviderName() };
    } catch (e) {
      return { ok: false, provider: this._provider.getProviderName(), error: e.message };
    }
  }
}

module.exports = { StorageService, generateChecksum };
