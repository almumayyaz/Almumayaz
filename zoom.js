const https = require('https');
const crypto = require('crypto');

var cachedToken = null;
var tokenExpiresAt = 0;

function getEnv(key, def) {
  return typeof process !== 'undefined' && process.env ? (process.env[key] || def || '') : (def || '');
}

function isConfigured() {
  return !!(getEnv('ZOOM_CLIENT_ID') && getEnv('ZOOM_CLIENT_SECRET') && getEnv('ZOOM_ACCOUNT_ID'));
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  if (!isConfigured()) throw new Error('ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET not set in .env');

  var clientId = getEnv('ZOOM_CLIENT_ID');
  var clientSecret = getEnv('ZOOM_CLIENT_SECRET');
  var accountId = getEnv('ZOOM_ACCOUNT_ID');
  var basic = Buffer.from(clientId + ':' + clientSecret).toString('base64');

  return new Promise(function(resolve, reject) {
    var body = 'grant_type=account_credentials&account_id=' + encodeURIComponent(accountId);
    var req = https.request({
      hostname: 'zoom.us',
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + basic,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try {
          var j = JSON.parse(data);
          if (j.access_token) {
            cachedToken = j.access_token;
            tokenExpiresAt = Date.now() + (j.expires_in - 60) * 1000;
            resolve(cachedToken);
          } else {
            reject(new Error('Zoom OAuth failed: ' + (j.error || data)));
          }
        } catch(e) { reject(new Error('Zoom OAuth parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function zoomApi(method, path, body) {
  var token = await getAccessToken();
  return new Promise(function(resolve, reject) {
    var opts = {
      hostname: 'api.zoom.us',
      path: '/v2' + path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      }
    };
    var payload = body ? JSON.stringify(body) : null;
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);
    var req = https.request(opts, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try {
          var j = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(j);
          } else {
            reject(new Error('Zoom API error ' + res.statusCode + ': ' + (j.message || data)));
          }
        } catch(e) { reject(new Error('Zoom API parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function createMeeting(opts) {
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
  var result = await zoomApi('POST', '/users/me/meetings', zoomBody);
  return {
    meetingId: String(result.id),
    joinUrl: result.join_url,
    startUrl: result.start_url,
    password: result.password || opts.password || ''
  };
}

async function getMeeting(meetingId) {
  return await zoomApi('GET', '/meetings/' + meetingId);
}

async function endMeeting(meetingId) {
  await zoomApi('PUT', '/meetings/' + meetingId + '/status', { action: 'end' });
}

function generateSignature(meetingNumber, role) {
  var sdkKey = getEnv('ZOOM_SDK_KEY');
  var sdkSecret = getEnv('ZOOM_SDK_SECRET');
  if (!sdkKey || !sdkSecret) {
    return '';
  }
  var ts = new Date().getTime() - 30000;
  var msg = sdkKey + '.' + meetingNumber + '.' + role + '.' + ts;
  var hash = crypto.createHmac('sha256', sdkSecret).update(msg).digest('base64');
  var sig = Buffer.from(sdkKey + '.' + meetingNumber + '.' + role + '.' + ts + '.' + hash).toString('base64');
  return sig;
}

module.exports = { isConfigured, getAccessToken, createMeeting, getMeeting, endMeeting, generateSignature };
