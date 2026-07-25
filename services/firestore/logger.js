const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LEVEL = LOG_LEVELS.INFO;

function log(level, label, msg, data) {
  if (LOG_LEVELS[level] < CURRENT_LEVEL) return;
  const ts = new Date().toISOString();
  const prefix = `[Firestore][${level}][${label}]`;
  if (data) console.log(`${ts} ${prefix} ${msg}`, typeof data === 'object' ? JSON.stringify(data).slice(0, 500) : data);
  else console.log(`${ts} ${prefix} ${msg}`);
}

module.exports = {
  debug: (label, msg, d) => log('DEBUG', label, msg, d),
  info: (label, msg, d) => log('INFO', label, msg, d),
  warn: (label, msg, d) => log('WARN', label, msg, d),
  error: (label, msg, d) => log('ERROR', label, msg, d),
};
