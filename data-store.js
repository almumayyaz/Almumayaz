const fs = require('fs').promises;
const path = require('path');

const dataDir = path.join(__dirname, 'data');

// In-memory cache for serverless environments
const memoryCache = new Map();

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
  const files = ['users.json', 'courses.json', 'announcements.json', 'subscriptions.json'];
  for (const file of files) {
    try {
      const content = await fs.readFile(path.join(dataDir, file), 'utf8');
      memoryCache.set(file, JSON.parse(content));
    } catch (e) {}
  }
}

init();

module.exports = { readData, writeData };