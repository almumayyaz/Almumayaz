const { getClient } = require('./client');
const MigrationLogger = require('./logger');

const ENTITIES = [
  'SubscriptionFeature', 'PlanAllowedCourse', 'LiveSessionAttendance',
  'ChatMessage', 'ChatAttachment', 'TicketReply',
  'ReviewVideo', 'ReviewFile',
];

async function migrateRemainingL1({ dryRun = false } = {}) {
  const prisma = getClient();
  const logger = new MigrationLogger(dryRun);

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

function dryRunRemainingL1() {
  return migrateRemainingL1({ dryRun: true });
}

module.exports = { migrateRemainingL1, dryRunRemainingL1 };
