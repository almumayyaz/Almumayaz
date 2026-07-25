const fs = require('./firestore');
const cache = require('./cache');
const log = require('./logger');

const usersRepo = require('./users.repository');
const coursesRepo = require('./courses.repository');
const settingsRepo = require('./settings.repository');
const notificationsRepo = require('./notifications.repository');
const subscriptionsRepo = require('./subscriptions.repository');
const paymentsRepo = require('./payments.repository');
const supportRepo = require('./support.repository');
const announcementsRepo = require('./announcements.repository');
const analyticsRepo = require('./analytics.repository');

module.exports = {
  ...fs,
  cache,
  log,
  users: usersRepo,
  courses: coursesRepo,
  settings: settingsRepo,
  notifications: notificationsRepo,
  subscriptions: subscriptionsRepo,
  payments: paymentsRepo,
  support: supportRepo,
  announcements: announcementsRepo,
  analytics: analyticsRepo,
};
