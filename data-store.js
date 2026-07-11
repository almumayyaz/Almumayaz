const fs = require('fs').promises;
const path = require('path');

const dataDir = path.join(__dirname, 'data');

// In-memory cache for serverless environments
const memoryCache = new Map();

// Preload with require() so JSON files are bundled on Vercel
try { memoryCache.set('courses.json', require('./data/courses.json')); } catch(e) {}
try { memoryCache.set('users.json', require('./data/users.json')); } catch(e) {}
try { memoryCache.set('announcements.json', require('./data/announcements.json')); } catch(e) {}
try { memoryCache.set('subscriptions.json', require('./data/subscriptions.json')); } catch(e) {}
try { memoryCache.set('reviews.json', require('./data/reviews.json')); } catch(e) {}
try { memoryCache.set('notes.json', require('./data/notes.json')); } catch(e) {}
try { memoryCache.set('questionBanks.json', require('./data/questionBanks.json')); } catch(e) {}
try { memoryCache.set('payments.json', require('./data/payments.json')); } catch(e) {}
try { memoryCache.set('settings.json', require('./data/settings.json')); } catch(e) {}
try { memoryCache.set('quotes.json', require('./data/quotes.json')); } catch(e) {}

async function readJSON(filename) {
  if (memoryCache.has(filename)) {
    return memoryCache.get(filename);
  }
  try {
    const content = await fs.readFile(path.join(dataDir, filename), 'utf8');
    const data = JSON.parse(content);
    memoryCache.set(filename, data);
    return data;
  } catch (e) {
    return filename.replace('.json', '').endsWith('s') ? [] : {};
  }
}

async function writeJSON(filename, data) {
  memoryCache.set(filename, data);
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
  const files = ['users.json', 'courses.json', 'announcements.json', 'subscriptions.json', 'reviews.json', 'payments.json'];
  for (const file of files) {
    try {
      const content = await fs.readFile(path.join(dataDir, file), 'utf8');
      memoryCache.set(file, JSON.parse(content));
    } catch (e) {}
  }
}

init();

module.exports = { readData, writeData };