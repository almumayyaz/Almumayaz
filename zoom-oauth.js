const https = require('https');
const crypto = require('crypto');
const { readData, writeData } = require('./prisma-bridge');
const { withTimeout } = require('./src/utils/timeout');

/* ------------------------------------------------------------------ */
/*  Zoom App Credentials — stored in Firebase, mirrored to process.env*/
/*  no redeploy needed when credentials change                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Credentials resolution: Firebase → process.env → fallback         */
/*  Cached in memory for 60s to avoid hitting Firebase every request  */
/* ------------------------------------------------------------------ */
var _credsCache = null;
var _credsCacheAt = 0;

async function resolveCreds() {
  // Try Firebase first
  if (Date.now() - _credsCacheAt > 60000) { _credsCache = null; }
  if (!_credsCache) {
    try {
      var fb = await readData('zoomAppCredentials');
      if (fb && fb.clientId && fb.clientSecret) {
        _credsCache = {
          clientId: fb.clientId,
          clientSecret: fb.clientSecret,
          redirectUri: fb.redirectUri || '',
          sdkKey: fb.sdkKey || '',
          sdkSecret: fb.sdkSecret || ''
        };
        _credsCacheAt = Date.now();
        return _credsCache;
      }
    } catch (e) { console.error('resolveCreds Firebase error:', e.message); }
  }
  if (_credsCache) return _credsCache;
  // Fallback to process.env
  var cid = process.env.ZOOM_CLIENT_ID || '';
  var csec = process.env.ZOOM_CLIENT_SECRET || '';
  if (cid && csec) return {
    clientId: cid,
    clientSecret: csec,
    redirectUri: process.env.ZOOM_REDIRECT_URI || '',
    sdkKey: process.env.ZOOM_SDK_KEY || '',
    sdkSecret: process.env.ZOOM_SDK_SECRET || ''
  };
  return null;
}

function invalidateCredsCache() { _credsCache = null; _credsCacheAt = 0; }

async function getStoredCredentials() { return resolveCreds(); }

async function loadCredentialsIntoEnv() {
  // Read from Firebase if available → set process.env
  try {
    var fb = await readData('zoomAppCredentials');
    if (fb && fb.clientId && fb.clientSecret) {
      process.env.ZOOM_CLIENT_ID = fb.clientId;
      process.env.ZOOM_CLIENT_SECRET = fb.clientSecret;
      process.env.ZOOM_REDIRECT_URI = fb.redirectUri || process.env.ZOOM_REDIRECT_URI || '';
      return;
    }
  } catch(e) {}
  // Firebase empty → just use Vercel env vars as-is (don't migrate automatically)
  // Migration happens when user saves via the form (saveCredentials)
}

async function saveCredentials(clientId, clientSecret, redirectUri, sdkKey, sdkSecret) {
  await writeData('zoomAppCredentials', {
    clientId: clientId || '',
    clientSecret: clientSecret || '',
    redirectUri: redirectUri || '',
    sdkKey: sdkKey || '',
    sdkSecret: sdkSecret || ''
  });
  // Mirror to process.env immediately so no restart needed
  process.env.ZOOM_CLIENT_ID = clientId || process.env.ZOOM_CLIENT_ID || '';
  process.env.ZOOM_CLIENT_SECRET = clientSecret || process.env.ZOOM_CLIENT_SECRET || '';
  process.env.ZOOM_REDIRECT_URI = redirectUri || process.env.ZOOM_REDIRECT_URI || '';
  process.env.ZOOM_SDK_KEY = sdkKey || process.env.ZOOM_SDK_KEY || '';
  process.env.ZOOM_SDK_SECRET = sdkSecret || process.env.ZOOM_SDK_SECRET || '';
}

/* ------------------------------------------------------------------ */
/*  Encryption — tokens encrypted at rest, key is server-only         */
/* ------------------------------------------------------------------ */
var _key = null;
function getKey() {
  if (_key) return _key;
  var secret = process.env.ZOOM_TOKEN_KEY || process.env.SESSION_SECRET || 'fallback-dev-key-change-in-production';
  _key = crypto.scryptSync(secret, 'zoom-encryption-salt', 32);
  return _key;
}

function encrypt(obj) {
  var iv = crypto.randomBytes(16);
  var cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  var enc = cipher.update(JSON.stringify(obj), 'utf8', 'hex');
  enc += cipher.final('hex');
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: enc, updatedAt: new Date().toISOString() };
}

function decrypt(blob) {
  try {
    var iv = Buffer.from(blob.iv, 'hex');
    var tag = Buffer.from(blob.tag, 'hex');
    var decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    var dec = decipher.update(blob.data, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return JSON.parse(dec);
  } catch (e) {
    throw new Error('Failed to decrypt Zoom credentials: ' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/*  Persistence — stored encrypted in Firebase RTDB (server-read-only)*/
/*  Per-teacher: tokens stored under zoomCredentials/<userId>         */
/* ------------------------------------------------------------------ */
var TOKEN_PREFIX = 'zoomCredentials';

function tokenKey(userId) {
  return TOKEN_PREFIX + '/' + (userId || 'global');
}

async function saveTokens(userId, tokens) {
  var encrypted = encrypt(tokens);
  await writeData(tokenKey(userId), encrypted);
}

async function loadTokens(userId) {
  var blob = await readData(tokenKey(userId));
  if (!blob || !blob.data) return null;
  return decrypt(blob);
}

async function clearTokens(userId) {
  await writeData(tokenKey(userId), null);
}

/* ------------------------------------------------------------------ */
/*  Helper: HTTPS request wrapper with timeout                        */
/* ------------------------------------------------------------------ */
function httpsRequest(opts, body) {
  return withTimeout(new Promise(function(resolve, reject) {
    var payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    var options = {
      hostname: opts.hostname || 'zoom.us',
      port: 443,
      path: opts.path,
      method: opts.method || 'GET',
      headers: opts.headers || {}
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  }), 'ZoomAPI');
}

function buildBasicAuth() {
  var cid = process.env.ZOOM_CLIENT_ID || '';
  var cs = process.env.ZOOM_CLIENT_SECRET || '';
  return Buffer.from(cid + ':' + cs).toString('base64');
}

/* ------------------------------------------------------------------ */
/*  OAuth URLs                                                        */
/* ------------------------------------------------------------------ */
function getAuthorizeUrl(state, redirectUri) {
  var clientId = process.env.ZOOM_CLIENT_ID || '';
  var finalRedirect = redirectUri || process.env.ZOOM_REDIRECT_URI || '';
  // Per Zoom docs, the General App authorization URL does NOT send a `scope=` parameter.
  // Scopes are configured on the Zoom Marketplace app (granular scopes) and must NOT be
  // passed here — sending legacy/classic scopes in the URL causes "Invalid scope".
  return 'https://zoom.us/oauth/authorize?response_type=code&client_id=' +
    encodeURIComponent(clientId) +
    '&redirect_uri=' + encodeURIComponent(finalRedirect) +
    '&state=' + encodeURIComponent(state || '');
}

/* ------------------------------------------------------------------ */
/*  Exchange authorization code for tokens                             */
/* ------------------------------------------------------------------ */
async function exchangeCode(code, redirectUri) {
  var finalRedirect = (redirectUri || process.env.ZOOM_REDIRECT_URI || '').trim();
  var body = 'grant_type=authorization_code&code=' + encodeURIComponent(code) +
    '&redirect_uri=' + encodeURIComponent(finalRedirect);
  var res = await httpsRequest({
    hostname: 'zoom.us',
    path: '/oauth/token',
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + buildBasicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  }, body);
  if (res.status >= 400) throw new Error('Token exchange failed: ' + (res.data.error || JSON.stringify(res.data)));
  return {
    accessToken: res.data.access_token,
    refreshToken: res.data.refresh_token,
    expiresIn: res.data.expires_in,
    scope: res.data.scope,
    tokenType: res.data.token_type
  };
}

/* ------------------------------------------------------------------ */
/*  Refresh access token                                              */
/* ------------------------------------------------------------------ */
async function refreshAccessToken(refreshToken) {
  var body = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refreshToken);
  var res = await httpsRequest({
    hostname: 'zoom.us',
    path: '/oauth/token',
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + buildBasicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  }, body);
  if (res.status >= 400) throw new Error('Token refresh failed: ' + (res.data.error || JSON.stringify(res.data)));
  return {
    accessToken: res.data.access_token,
    refreshToken: res.data.refresh_token,
    expiresIn: res.data.expires_in,
    scope: res.data.scope,
    tokenType: res.data.token_type
  };
}

/* ------------------------------------------------------------------ */
/*  Get a valid access token (auto-refresh if expired)                 */
/* ------------------------------------------------------------------ */
async function getValidAccessToken(userId) {
  var tokens = await loadTokens(userId);
  if (!tokens) return null;
  // If access token is within 5 minutes of expiry, refresh it
  var expiresAt = tokens.expiresAt || 0;
  if (Date.now() >= expiresAt - 300000) {
    try {
      var fresh = await refreshAccessToken(tokens.refreshToken);
      fresh.expiresAt = Date.now() + (fresh.expiresIn || 3600) * 1000;
      fresh.userId = tokens.userId;
      fresh.userName = tokens.userName;
      fresh.userEmail = tokens.userEmail;
      fresh.userAvatar = tokens.userAvatar;
      fresh.connectedAt = tokens.connectedAt;
      await saveTokens(userId, fresh);
      return fresh.accessToken;
    } catch (e) {
      console.error('Zoom token refresh failed:', e.message);
      return null;
    }
  }
  return tokens.accessToken;
}

/* ------------------------------------------------------------------ */
/*  Get Zoom user profile (after successful OAuth)                     */
/* ------------------------------------------------------------------ */
async function getUserProfile(accessToken) {
  var res = await httpsRequest({
    hostname: 'api.zoom.us',
    path: '/v2/users/me',
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + accessToken }
  });
  if (res.status >= 400) throw new Error('Failed to get user profile: ' + (res.data.message || JSON.stringify(res.data)));
  return {
    id: res.data.id,
    name: res.data.display_name || res.data.first_name + ' ' + (res.data.last_name || ''),
    email: res.data.email,
    avatar: res.data.pic_url || ''
  };
}

/* ------------------------------------------------------------------ */
/*  Complete OAuth callback flow: code → tokens → profile → save      */
/* ------------------------------------------------------------------ */
async function completeOAuth(userId, code, redirectUri) {
  var tokenData = await exchangeCode(code, redirectUri);
  console.error('ZOOM DEBUG granted scope:', tokenData.scope);
  var profile = await getUserProfile(tokenData.accessToken);
  var tokens = {
    accessToken: tokenData.accessToken,
    refreshToken: tokenData.refreshToken,
    expiresIn: tokenData.expiresIn,
    expiresAt: Date.now() + (tokenData.expiresIn || 3600) * 1000,
    userId: profile.id,
    userName: profile.name,
    userEmail: profile.email,
    userAvatar: profile.avatar,
    connectedAt: new Date().toISOString()
  };
  await saveTokens(userId, tokens);
  return tokens;
}

/* ------------------------------------------------------------------ */
/*  Check connection status                                           */
/* ------------------------------------------------------------------ */
async function getStatus(userId) {
  var tokens = await loadTokens(userId);
  if (!tokens) return { connected: false };
  var accessToken = await getValidAccessToken(userId);
  return {
    connected: !!accessToken,
    userId: tokens.userId || '',
    userName: tokens.userName || '',
    userEmail: tokens.userEmail || '',
    userAvatar: tokens.userAvatar || '',
    connectedAt: tokens.connectedAt || '',
    tokenExpired: !accessToken && !!tokens
  };
}

/* ------------------------------------------------------------------ */
/*  Disconnect: revoke tokens (if possible) and clear storage          */
/* ------------------------------------------------------------------ */
async function disconnect(userId) {
  var tokens = await loadTokens(userId);
  if (tokens && tokens.accessToken) {
    // Attempt token revocation (best-effort)
    try {
      var basic = buildBasicAuth();
      var body = 'token=' + encodeURIComponent(tokens.accessToken) + '&token_type_hint=access_token';
      await httpsRequest({
        hostname: 'zoom.us',
        path: '/oauth/revoke',
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + basic,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }, body);
    } catch (e) { /* best-effort revoke */ }
  }
  await clearTokens(userId);
}

/* ------------------------------------------------------------------ */
/*  Create meeting using teacher's Zoom account                        */
/* ------------------------------------------------------------------ */
async function createMeeting(userId, opts) {
  var accessToken = await getValidAccessToken(userId);
  if (!accessToken) throw new Error('يجب ربط حساب Zoom أولاً');
  var zoomBody = {
    topic: opts.title || 'حصة مباشرة',
    type: 2,
    start_time: opts.startTime ? new Date(opts.startTime).toISOString() : undefined,
    duration: opts.duration || 60,
    timezone: 'Africa/Cairo',
    settings: {
      host_video: true,
      participant_video: true,
      join_before_host: !!opts.allowJoinBeforeTeacher,
      waiting_room: !!opts.waitingRoom,
      approval_type: opts.waitingRoom ? 0 : 2,
      mute_upon_entry: true,
      audio: 'both',
      auto_recording: opts.recording ? 'cloud' : 'none'
    }
  };
  if (opts.password) {
    zoomBody.password = opts.password;
    zoomBody.settings.alphanumeric_pin = true;
  }

  var res = await httpsRequest({
    hostname: 'api.zoom.us',
    path: '/v2/users/me/meetings',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    }
  }, zoomBody);

  if (res.status >= 400) {
    var msg = res.data ? (res.data.message || JSON.stringify(res.data)) : 'HTTP ' + res.status;
    throw new Error('فشل إنشاء الاجتماع: ' + msg);
  }
  return {
    meetingId: String(res.data.id),
    joinUrl: res.data.join_url,
    startUrl: res.data.start_url,
    password: res.data.password || opts.password || ''
  };
}

/* ------------------------------------------------------------------ */
/*  End meeting using teacher's Zoom account                           */
/* ------------------------------------------------------------------ */
async function endMeeting(userId, meetingId) {
  var accessToken = await getValidAccessToken(userId);
  if (!accessToken) throw new Error('يجب ربط حساب Zoom أولاً');
  var res = await httpsRequest({
    hostname: 'api.zoom.us',
    path: '/v2/meetings/' + meetingId + '/status',
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    }
  }, { action: 'end' });
  if (res.status >= 400) throw new Error('فشل إنهاء الاجتماع: ' + (res.data.message || JSON.stringify(res.data)));
}

/* ------------------------------------------------------------------ */
/*  Generate Zoom Meeting SDK JWT signature (always required)         */
/*  Uses OAuth app Client ID + Client Secret — no separate SDK creds  */
/*  Format: standard JWT (HS256) with sdkKey, mn, role, iat, exp     */
/* ------------------------------------------------------------------ */
function generateSignature(meetingNumber, role, sdkKey, sdkSecret) {
  if (!sdkKey) sdkKey = process.env.ZOOM_SDK_KEY || '';
  if (!sdkSecret) sdkSecret = process.env.ZOOM_SDK_SECRET || '';
  if (!sdkKey || !sdkSecret) {
    return '';
  }
  var iat = Math.round(Date.now() / 1000) - 30;
  var exp = iat + 7200; // 2 hours
  var header = { alg: 'HS256', typ: 'JWT' };
  var payload = {
    appKey: sdkKey,
    sdkKey: sdkKey,
    mn: String(meetingNumber),
    role: role,
    iat: iat,
    exp: exp,
    tokenExp: exp
  };
  var b64 = function(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  };
  var headerB64 = b64(header);
  var payloadB64 = b64(payload);
  var signature = crypto.createHmac('sha256', sdkSecret)
    .update(headerB64 + '.' + payloadB64)
    .digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return headerB64 + '.' + payloadB64 + '.' + signature;
}

/* ------------------------------------------------------------------ */
/*  Get meeting details using teacher's tokens                         */
/* ------------------------------------------------------------------ */
async function getMeeting(userId, meetingId) {
  var accessToken = await getValidAccessToken(userId);
  if (!accessToken) throw new Error('يجب ربط حساب Zoom أولاً');
  var res = await httpsRequest({
    hostname: 'api.zoom.us',
    path: '/v2/meetings/' + meetingId,
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + accessToken }
  });
  if (res.status >= 400) throw new Error('فشل جلب بيانات الاجتماع');
  return res.data;
}

/* ------------------------------------------------------------------ */
/*  Check if Zoom OAuth is configured (client ID + secret + redirect)  */
/* ------------------------------------------------------------------ */
function isConfigured() {
  return !!(process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET && process.env.ZOOM_REDIRECT_URI);
}

/* ------------------------------------------------------------------ */
/*  Async helper: resolve creds from Firebase then generate signature  */
/* ------------------------------------------------------------------ */
async function generateSignatureAsync(meetingNumber, role) {
  var creds = await resolveCreds();
  var sdkKey = creds ? creds.sdkKey : (process.env.ZOOM_SDK_KEY || '');
  var sdkSecret = creds ? creds.sdkSecret : (process.env.ZOOM_SDK_SECRET || '');
  // Fallback to OAuth Client ID/Secret if SDK creds not set
  if (!sdkKey) sdkKey = creds ? creds.clientId : (process.env.ZOOM_CLIENT_ID || '');
  if (!sdkSecret) sdkSecret = creds ? creds.clientSecret : (process.env.ZOOM_CLIENT_SECRET || '');
  return generateSignature(meetingNumber, role, sdkKey, sdkSecret);
}

module.exports = {
  isConfigured,
  getAuthorizeUrl,
  exchangeCode,
  completeOAuth,
  getStatus,
  disconnect,
  getValidAccessToken,
  createMeeting,
  endMeeting,
  getMeeting,
  generateSignature,
  generateSignatureAsync,
  loadTokens,
  saveTokens,
  clearTokens,
  loadCredentialsIntoEnv,
  saveCredentials,
  getStoredCredentials
};
