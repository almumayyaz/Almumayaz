const { StorageProvider } = require('./StorageProvider');
const supabaseStorage = require('../../../../supabase-storage');

class LegacyStorageAdapter extends StorageProvider {
  getProviderName() {
    return 'supabase-legacy';
  }

  getBucket() {
    return supabaseStorage.BUCKET || 'books';
  }

  isConfigured() {
    return supabaseStorage.isConfigured();
  }

  async upload({ key, body, contentType, metadata, visibility }) {
    const folder = key.split('/')[0] || 'misc';
    const originalName = (metadata && metadata.originalName) || key.split('/').pop() || 'file';
    const path = await supabaseStorage.uploadPdf(folder, originalName, body, contentType || 'application/octet-stream');
    return { objectKey: path, bucket: this.getBucket(), mimeType: contentType, size: body.length };
  }

  async delete(objectKey) {
    return supabaseStorage.removePdf(objectKey);
  }

  async exists(objectKey) {
    try {
      await supabaseStorage.createSignedUrl(objectKey, 30);
      return true;
    } catch (e) {
      if (e.code === 'NOT_CONFIGURED') throw e;
      return false;
    }
  }

  async createSignedUrl(objectKey, ttlSecs) {
    return supabaseStorage.createSignedUrl(objectKey, ttlSecs);
  }

  async createPublicUrl(objectKey) {
    throw new Error('LegacyStorageAdapter does not support public URLs');
  }

  async getObject(objectKey) {
    const signedUrl = await supabaseStorage.createSignedUrl(objectKey, 60);
    const response = await fetch(signedUrl);
    if (!response.ok) throw new Error(`Failed to fetch object: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, contentType: 'application/pdf', contentLength: buffer.length };
  }

  async listObjects(prefix) {
    throw new Error('LegacyStorageAdapter does not support listObjects');
  }

  async createSignedUploadUrl(objectKey, contentType) {
    const data = await supabaseStorage.createSignedUploadUrl(objectKey);
    return { signedUrl: data.signedUrl, objectKey: data.path || objectKey };
  }

  async copy(sourceKey, destKey) {
    throw new Error('LegacyStorageAdapter does not support copy');
  }
}

module.exports = { LegacyStorageAdapter };
