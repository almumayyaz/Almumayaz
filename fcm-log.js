// In-memory FCM send log (ephemeral — survives single instance lifetime)
const MAX = 100;
const _logs = [];

function add(entry) {
  _logs.unshift({ timestamp: new Date().toISOString(), ...entry });
  if (_logs.length > MAX) _logs.length = MAX;
}

function list(limit) { return _logs.slice(0, limit || 20); }

module.exports = { add, list };
