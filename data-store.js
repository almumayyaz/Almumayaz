const fs = require('fs').promises;
const path = require('path');

const dataDir = path.join(__dirname, 'data');

// In-memory cache for serverless environments.
// Stage 14: bounded with a TTL so large data is never held in memory forever.
const LOCAL_TTL_MS = 5 * 60 * 1000;
const memoryCache = new Map(); // filename -> { value, expires }

function setCached(filename, data, ttl) {
  memoryCache.set(filename, { value: data, expires: Date.now() + (ttl || LOCAL_TTL_MS) });
}

function getCached(filename) {
  const e = memoryCache.get(filename);
  if (!e) return undefined;
  if (Date.now() > e.expires) { memoryCache.delete(filename); return undefined; }
  return e.value;
}

// Preload with require() so JSON files are bundled on Vercel
try { setCached('courses.json', require('./data/courses.json')); } catch(e) {}
try { setCached('users.json', require('./data/users.json')); } catch(e) {}
try { setCached('announcements.json', require('./data/announcements.json')); } catch(e) {}
try { setCached('subscriptions.json', require('./data/subscriptions.json')); } catch(e) {}
try { setCached('reviews.json', require('./data/reviews.json')); } catch(e) {}
try { setCached('notes.json', require('./data/notes.json')); } catch(e) {}
try { setCached('questionBanks.json', require('./data/questionBanks.json')); } catch(e) {}
try { setCached('payments.json', require('./data/payments.json')); } catch(e) {}
try { setCached('settings.json', require('./data/settings.json')); } catch(e) {}
try { setCached('quotes.json', require('./data/quotes.json')); } catch(e) {}
try { setCached('parentInvites.json', require('./data/parentInvites.json')); } catch(e) {}

async function readJSON(filename) {
  const cached = getCached(filename);
  if (cached !== undefined) return cached;
  try {
    const content = await fs.readFile(path.join(dataDir, filename), 'utf8');
    const data = JSON.parse(content);
    setCached(filename, data);
    return data;
  } catch (e) {
    return filename.replace('.json', '').endsWith('s') ? [] : {};
  }
}

async function writeJSON(filename, data) {
  setCached(filename, data);
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, filename), JSON.stringify(data, null, 2));
  } catch (e) {
    console.log('Note: Using in-memory storage for ' + filename);
  }
}

async function readData(key) {
  const filename = key.endsWith('s') ? key + '.json' : key + '.json';
  return readJSON(filename);
}

async function writeData(key, data) {
  const filename = key.endsWith('s') ? key + '.json' : key + '.json';
  return writeJSON(filename, data);
}

async function init() {
  const files = ['users.json', 'courses.json', 'announcements.json', 'subscriptions.json', 'reviews.json', 'payments.json', 'notifications.json', 'parentInvites.json'];
  for (const file of files) {
    try {
      const content = await fs.readFile(path.join(dataDir, file), 'utf8');
      setCached(file, JSON.parse(content));
    } catch (e) {}
  }
}

init();

module.exports = { readData, writeData };
