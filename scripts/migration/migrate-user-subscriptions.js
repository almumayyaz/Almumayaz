const { getClient } = require('./client');
const { resolveId } = require('./id-mapping');
const { readUsers } = require('./legacy-reader');
const { safeDate, safeString, newCuid } = require('./utils');
const MigrationLogger = require('./logger');

async function migrateUserSubscriptions({ dryRun = false } = {}) {
  const prisma = getClient();
  const logger = new MigrationLogger(dryRun);

  const legacy = readUsers();
  let legacyCount = 0;

  if (dryRun) {
    logger.start('UserSubscription');
    legacyCount = legacy.filter(u => u.subscriptionStatus).length;
    logger.read('UserSubscription', legacyCount);
    logger.done('UserSubscription', 0, legacyCount);
    return logger.report();
  }

  logger.start('UserSubscription');
  legacyCount = legacy.filter(u => u.subscriptionStatus).length;
  logger.read('UserSubscription', legacyCount);

  let created = 0;
  let skipped = 0;

  for (const u of legacy) {
    if (!u.subscriptionStatus) continue;

    const userId = await resolveId('User', u.id);
    if (!userId) {
      logger.logSkipped('UserSubscription', u.id, 'user not in IdMapping');
      skipped++;
      continue;
    }

    try {
      const existing = await prisma.userSubscription.findFirst({
        where: { userId, status: u.subscriptionStatus },
      });
      if (existing) {
        skipped++;
        continue;
      }

      if (dryRun) { created++; continue; }

      await prisma.userSubscription.create({
        data: {
          id: newCuid(),
          userId,
          planName: safeString(u.planName, ''),
          planId: safeString(u.planId, ''),
          status: safeString(u.subscriptionStatus, 'active'),
          startDate: safeDate(u.subscriptionStart) || new Date(),
          endDate: safeDate(u.subscriptionEnd) || null,
          cancelledAt: null,
          period: safeString(u.planPeriod, 'شهرياً'),
          stage: safeString(u.subscribedStage, ''),
          discount: 0,
          price: null,
        },
      });
      logger.logCreated('UserSubscription', u.id, userId);
      created++;
    } catch (e) {
      logger.logFailed('UserSubscription', u.id, e);
    }
  }

  logger.found('UserSubscription', legacyCount);
  logger.done('UserSubscription', created, skipped);

  const dbCount = await prisma.userSubscription.count();
  return {
    report: logger.report(),
    summary: logger.summary(),
    legacyCount,
    dbCount,
    createdCount: created,
    skipCount: skipped,
  };
}

function dryRunUserSubscriptions() {
  return migrateUserSubscriptions({ dryRun: true });
}

module.exports = { migrateUserSubscriptions, dryRunUserSubscriptions };
