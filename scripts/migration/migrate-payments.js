const { getClient } = require('./client');
const { createMapping, resolveId, getMappingCount } = require('./id-mapping');
const { readPayments } = require('./legacy-reader');
const { safeDate, safeNumber, safeString, newCuid } = require('./utils');
const MigrationLogger = require('./logger');

async function migratePayments({ dryRun = false } = {}) {
  const prisma = getClient();
  const logger = new MigrationLogger(dryRun);

  const legacy = readPayments();
  const entity = 'Payment';
  logger.start(entity);
  logger.read(entity, legacy.length);

  if (dryRun) {
    logger.done(entity, 0, legacy.length);
    return logger.report();
  }

  let created = 0;
  let skipped = 0;

  for (const p of legacy) {
    try {
      const existingMapping = await prisma.idMapping.findFirst({
        where: { entityType: entity, legacyId: p.id },
      });
      if (existingMapping) {
        skipped++;
        logger.logSkipped(entity, p.id, 'already mapped');
        continue;
      }

      const userId = await resolveId('User', p.userId);
      if (!userId) {
        skipped++;
        logger.logSkipped(entity, p.id, 'User not in IdMapping');
        continue;
      }

      const newId = newCuid();
      const amount = safeNumber(p.amount, null);
      await prisma.payment.create({
        data: {
          id: newId,
          userId,
          userName: safeString(p.userName),
          amount: amount !== null ? amount : null,
          method: safeString(p.method),
          transactionId: safeString(p.transactionId),
          status: safeString(p.status, 'pending'),
          planName: safeString(p.planName),
          rejectReason: safeString(p.rejectReason),
          date: safeDate(p.date) || new Date(),
        },
      });
      await createMapping(entity, p.id, newId);
      logger.logCreated(entity, p.id, newId);
      created++;
    } catch (e) {
      logger.logFailed(entity, p.id, e);
    }
  }

  logger.found(entity, legacy.length);
  logger.done(entity, created, skipped);

  const dbCount = await prisma.payment.count();
  const mappingCount = await getMappingCount();

  return {
    report: logger.report(),
    summary: logger.summary(),
    legacyCount: legacy.length,
    dbCount,
    createdCount: created,
    skipCount: skipped,
    mappingCount,
  };
}

function dryRunPayments() {
  return migratePayments({ dryRun: true });
}

module.exports = { migratePayments, dryRunPayments };
