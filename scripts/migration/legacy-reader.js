const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../../data');

function readUsers() {
  const filePath = path.join(DATA_DIR, 'users.json');
  if (!fs.existsSync(filePath)) {
    console.error(`[LegacyReader] users.json not found at ${filePath}`);
    return [];
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function readCourses() {
  const filePath = path.join(DATA_DIR, 'courses.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readPayments() {
  const filePath = path.join(DATA_DIR, 'payments.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readSubRequests() {
  const filePath = path.join(DATA_DIR, 'subRequests.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readSubscriptions() {
  const filePath = path.join(DATA_DIR, 'subscriptions.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readNotes() {
  const filePath = path.join(DATA_DIR, 'notes.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readQuestionBanks() {
  const filePath = path.join(DATA_DIR, 'questionBanks.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readReviews() {
  const filePath = path.join(DATA_DIR, 'reviews.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readSettings() {
  const filePath = path.join(DATA_DIR, 'settings.json');
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readAnnouncements() {
  const filePath = path.join(DATA_DIR, 'announcements.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readQuotes() {
  const filePath = path.join(DATA_DIR, 'quotes.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readScheduledNotifications() {
  const filePath = path.join(DATA_DIR, 'scheduledNotifications.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readZoomAppCredentials() {
  const filePath = path.join(DATA_DIR, 'zoomAppCredentials.json');
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  readUsers,
  readCourses,
  readPayments,
  readSubRequests,
  readSubscriptions,
  readNotes,
  readQuestionBanks,
  readReviews,
  readSettings,
  readAnnouncements,
  readQuotes,
  readScheduledNotifications,
  readZoomAppCredentials,
};
