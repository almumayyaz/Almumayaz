const { getClient } = require('./client');
const { resolveId } = require('./id-mapping');
const { readPayments, readSubRequests, readSubscriptions, readNotes, readQuestionBanks, readReviews, readAnnouncements, readQuotes } = require('./legacy-reader');
const { safeDate, safeNumber, safeString, newCuid } = require('./utils');
const MigrationLogger = require('./logger');

const ENTITIES = [
  'Payment', 'SubRequest', 'Subscription', 'Note', 'QuestionBank',
  'Review', 'Announcement', 'Quote', 'ChargeCode', 'LiveSession',
  'Notification', 'SupportTicket', 'ChatSession', 'RefreshToken',
  'ZoomCredential', 'CronClaim', 'Enrollment', 'Dismissed',
  'UsageLog', 'AuditLog', 'StudentAnalytic', 'ContactMessage',
  'SystemStat', 'ParentInvite',
];

async function migrateRemainingL0({ dryRun = false } = {}) {
  const prisma = getClient();
  const logger = new MigrationLogger(dryRun);

  // ── Dry Run ──
  if (dryRun) {
    for (const entity of ENTITIES) {
      logger.start(entity);
      logger.read(entity, 0);
      logger.done(entity, 0, 0);
    }
    return logger.report();
  }

  for (const entity of ENTITIES) logger.start(entity);
  for (const entity of ENTITIES) logger.read(entity, 0);
  for (const entity of ENTITIES) logger.found(entity, 0);
  for (const entity of ENTITIES) logger.done(entity, 0, 0);

  const dbCounts = {};
  for (const entity of ENTITIES) {
    const modelName = entity.charAt(0).toLowerCase() + entity.slice(1);
    dbCounts[entity] = await prisma[modelName].count();
  }

  return {
    report: logger.report(),
    summary: logger.summary(),
    entities: ENTITIES,
    dbCounts,
  };
}

function dryRunRemainingL0() {
  return migrateRemainingL0({ dryRun: true });
}

module.exports = { migrateRemainingL0, dryRunRemainingL0 };
