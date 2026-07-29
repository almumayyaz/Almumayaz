const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, CopyObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { StorageProvider } = require('./StorageProvider');

class CloudflareR2Provider extends StorageProvider {
  constructor(options = {}) {
    super();
    const accessKeyId = options.accessKeyId || process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = options.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY;
    const endpoint = options.endpoint || process.env.R2_ENDPOINT;
    const region = options.region || process.env.R2_REGION || 'auto';
    const bucket = options.bucket || process.env.R2_BUCKET;
    const publicUrl = options.publicUrl || process.env.R2_PUBLIC_URL;

    if (!accessKeyId) throw new Error('R2_ACCESS_KEY_ID is required');
    if (!secretAccessKey) throw new Error('R2_SECRET_ACCESS_KEY is required');
    if (!endpoint) throw new Error('R2_ENDPOINT is required');
    if (!bucket) throw new Error('R2_BUCKET is required');

    this._bucket = bucket;
    this._publicUrl = publicUrl || '';
    this._client = new S3Client({
      region,
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      requestHandler: { requestTimeout: 30000 }
    });
  }

  getProviderName() {
    return 'cloudflare-r2';
  }

  getBucket() {
    return this._bucket;
  }

  async upload({ key, body, contentType, metadata, visibility }) {
    const cacheControl = visibility === 'public'
      ? 'public, max-age=31536000, immutable'
      : 'private, max-age=0, must-revalidate';

    const command = new PutObjectCommand({
      Bucket: this._bucket,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
      CacheControl: cacheControl,
      Metadata: metadata || {}
    });
    await this._client.send(command);
    return { objectKey: key, bucket: this._bucket, mimeType: contentType, size: body.length };
  }

  async delete(objectKey) {
    const command = new DeleteObjectCommand({ Bucket: this._bucket, Key: objectKey });
    await this._client.send(command);
    return true;
  }

  async exists(objectKey) {
    try {
      const command = new HeadObjectCommand({ Bucket: this._bucket, Key: objectKey });
      await this._client.send(command);
      return true;
    } catch (e) {
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
      throw e;
    }
  }

  async createSignedUrl(objectKey, ttlSecs = 3600) {
    const command = new GetObjectCommand({ Bucket: this._bucket, Key: objectKey });
    return getSignedUrl(this._client, command, { expiresIn: Math.max(ttlSecs, 60) });
  }

  async createPublicUrl(objectKey) {
    if (!this._publicUrl) throw new Error('R2_PUBLIC_URL not configured');
    return `${this._publicUrl.replace(/\/+$/, '')}/${objectKey}`;
  }

  async getObject(objectKey) {
    const command = new GetObjectCommand({ Bucket: this._bucket, Key: objectKey });
    const response = await this._client.send(command);
    const buffer = await response.Body.transformToByteArray();
    return {
      buffer: Buffer.from(buffer),
      contentType: response.ContentType || 'application/octet-stream',
      contentLength: response.ContentLength || buffer.length
    };
  }

  async listObjects(prefix = '') {
    const command = new ListObjectsV2Command({ Bucket: this._bucket, Prefix: prefix });
    const response = await this._client.send(command);
    return (response.Contents || []).map(item => ({
      objectKey: item.Key,
      size: item.Size,
      lastModified: item.LastModified
    }));
  }

  async createSignedUploadUrl(objectKey, contentType = 'application/octet-stream') {
    const command = new PutObjectCommand({
      Bucket: this._bucket,
      Key: objectKey,
      ContentType: contentType
    });
    const signedUrl = await getSignedUrl(this._client, command, { expiresIn: 3600 });
    return { signedUrl, objectKey };
  }

  async copy(sourceKey, destKey) {
    const command = new CopyObjectCommand({
      Bucket: this._bucket,
      CopySource: `${this._bucket}/${sourceKey}`,
      Key: destKey
    });
    await this._client.send(command);
    return { objectKey: destKey, bucket: this._bucket };
  }
}

module.exports = { CloudflareR2Provider };
