// Supabase Storage wrapper for private PDF hosting.
// All PDFs (lessons, reviews, notes) are stored in a PRIVATE bucket called "books".
// No public URLs are ever generated. Access is granted only via short-lived signed URLs
// (30-60s) created per request, after the app has verified login + subscription + permissions.
//
// Env vars (add these in Vercel project settings):
//   SUPABASE_URL            e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  (server-only secret, never exposed to the browser)
//   SUPABASE_ANON_KEY       (optional; service role is used for admin ops)
//
// The module degrades gracefully: if creds are missing, isConfigured() is false and
// every function returns a clear error instead of crashing the app.

let _client = null;
let _configured = false;
let _bucketReady = false;
const BUCKET = 'books';

function isConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function _getClient() {
  if (_client) return _client;
  if (!isConfigured()) return null;
  let supabase;
  try {
    supabase = require('@supabase/supabase-js');
  } catch (e) {
    console.error('[supabase-storage] @supabase/supabase-js is not installed. Run: npm install @supabase/supabase-js');
    return null;
  }
  _client = supabase.createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  return _client;
}

// Create the private bucket once at boot (idempotent).
async function ensureBucket() {
  if (_bucketReady) return true;
  const client = _getClient();
  if (!client) {
    console.warn('[supabase-storage] Not configured - PDF storage disabled. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.');
    return false;
  }
  try {
    const { data: existing } = await client.storage.getBucket(BUCKET);
    if (!existing) {
      const { error } = await client.storage.createBucket(BUCKET, {
        public: false,
        allowedMimeTypes: ['application/pdf'],
        fileSizeLimit: 50 * 1024 * 1024
      });
      if (error) {
        // 409 / already exists is fine
        if (String(error.message || '').toLowerCase().indexOf('already exists') === -1) {
          console.error('[supabase-storage] createBucket error:', error.message);
          return false;
        }
      }
      console.log('[supabase-storage] Private bucket "' + BUCKET + '" ready.');
    }
    _bucketReady = true;
    return true;
  } catch (e) {
    console.error('[supabase-storage] ensureBucket failed:', e.message);
    return false;
  }
}

function _sanitizeName(name) {
  let base = String(name || 'file')
    .replace(/\.[pP][dD][fF]$/, '')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return base || 'file';
}

// Upload a buffer to the private bucket. Returns the storage object path (e.g. lessons/uuid-name.pdf).
async function uploadPdf(folder, originalName, buffer, contentType) {
  const client = _getClient();
  if (!client) throw new Error('Supabase storage not configured');
  if (!_bucketReady) await ensureBucket();
  const { v4: uuid } = require('uuid');
  const safe = _sanitizeName(originalName);
  const path = (folder || 'misc') + '/' + uuid() + '-' + safe + '.pdf';
  const { error } = await client.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: contentType || 'application/pdf', upsert: true, cacheControl: '0' });
  if (error) throw new Error(error.message || 'Upload failed');
  return path;
}

async function removePdf(path) {
  const client = _getClient();
  if (!client || !path) return false;
  const { error } = await client.storage.from(BUCKET).remove([path]);
  if (error) {
    console.warn('[supabase-storage] remove failed:', error.message);
    return false;
  }
  return true;
}

// Create a short-lived SIGNED UPLOAD URL so the browser can upload the file
// DIRECTLY to Supabase, bypassing the Vercel serverless body-size limit (413).
// Returns { signedUrl, token, path }.
async function createSignedUploadUrl(filePath) {
  const client = _getClient();
  if (!client || !filePath) throw new Error('Supabase storage not configured');
  if (!_bucketReady) await ensureBucket();
  const { data, error } = await client.storage.from(BUCKET).createSignedUploadUrl(filePath);
  if (error) throw new Error(error.message || 'Sign failed');
  if (!data) throw new Error('No signed upload URL returned');
  return data;
}

// Create a short-lived signed URL (default 60s, max within 30-60s range per spec).
async function createSignedUrl(path, expiresIn) {
  const client = _getClient();
  if (!client || !path) {
    const e = new Error('Supabase storage not configured');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  let secs = parseInt(expiresIn, 10);
  if (!secs || secs < 30) secs = 60;
  if (secs > 60) secs = 60;
  let data = null, error = null, thrown = null;
  try {
    const res = await client.storage.from(BUCKET).createSignedUrl(path, secs);
    data = res.data;
    error = res.error;
  } catch (e) {
    thrown = e; // network-level failure (DNS/timeout) - supabase-js may throw rather than return error
  }
  if (thrown) {
    console.error('[supabase-storage] createSignedUrl THREW (possible network/unreachable):', {
      path, bucket: BUCKET, message: thrown.message, code: thrown.code, status: thrown.status, stack: thrown.stack
    });
    const e = new Error('Supabase request threw: ' + (thrown.message || thrown));
    e.code = thrown.code || 'NETWORK_OR_THROWN';
    e.status = thrown.status;
    e.cause = thrown;
    throw e;
  }
  if (error) {
    console.error('[supabase-storage] createSignedUrl returned error object:', {
      path, bucket: BUCKET, message: error.message, status: error.status, code: error.code, full: JSON.stringify(error)
    });
    const e = new Error('Supabase error: ' + (error.message || 'Sign failed'));
    e.code = error.code || ('STATUS_' + (error.status || 'unknown'));
    e.status = error.status;
    e.supabaseError = error;
    throw e;
  }
  if (!data || !data.signedUrl) {
    console.error('[supabase-storage] createSignedUrl returned no signedUrl:', { path, bucket: BUCKET, data });
    const e = new Error('No signed URL returned');
    e.code = 'NO_SIGNED_URL';
    throw e;
  }
  return data.signedUrl;
}

module.exports = {
  BUCKET,
  isConfigured,
  ensureBucket,
  uploadPdf,
  removePdf,
  createSignedUploadUrl,
  createSignedUrl
};
