const { getClient } = require('./client');
const { resolveId } = require('./id-mapping');
const { readUsers } = require('./legacy-reader');
const { safeDate, safeNumber } = require('./utils');
const MigrationLogger = require('./logger');

async function dryRunRelations() {
  const legacy = readUsers();
  let parentRelations = 0;
  let childrenRelations = 0;
  let referrals = 0;
  let referredByFallback = 0;
  const orphanRefs = [];

  for (const u of legacy) {
    if (u.parentId) {
      parentRelations++;
    }
    if (u.childrenIds && Array.isArray(u.childrenIds) && u.childrenIds.length) {
      childrenRelations += u.childrenIds.length;
    }
    if (u.referrals && Array.isArray(u.referrals) && u.referrals.length) {
      referrals += u.referrals.length;
    }
    if (u.referredBy && (!u.referrals || !u.referrals.length)) {
      referredByFallback++;
    }
  }

  console.log('\n══════════════════════════════════');
  console.log('   RELATIONS — DRY RUN');
  console.log('══════════════════════════════════');
  console.log(`  Parent relations:        ${parentRelations}`);
  console.log(`  Children relations:      ${childrenRelations}`);
  console.log(`  Referrals (from array):  ${referrals}`);
  console.log(`  ReferredBy fallback:     ${referredByFallback}`);
  console.log(`  Orphan references:       ${orphanRefs.length}`);

  if (orphanRefs.length) {
    console.log('\n  Orphan details:');
    for (const o of orphanRefs) {
      console.log(`    ✗ ${o}`);
    }
  }

  return {
    parentRelations,
    childrenRelations,
    referrals,
    referredByFallback,
    orphanRefs,
  };
}

async function migrateChildRelation(legacy, logger, entity) {
  const prisma = getClient();
  let created = 0;
  let skipped = 0;

  for (const u of legacy) {
    const parentNewId = await resolveId('User', u.id);
    if (!parentNewId) {
      logger.logSkipped(entity, u.id, 'parent user not found in IdMapping');
      continue;
    }

    // parentId on the user record
    if (u.parentId) {
      const resolvedParentId = await resolveId('User', u.parentId);
      if (!resolvedParentId) {
        logger.logSkipped(entity, `${u.id} → parent:${u.parentId}`, 'parentId not resolved');
        continue;
      }
      try {
        await prisma.childRelation.upsert({
          where: { parentId_childId: { parentId: resolvedParentId, childId: parentNewId } },
          update: {},
          create: { parentId: resolvedParentId, childId: parentNewId },
        });
        created++;
      } catch (e) {
        if (e.code === 'P2002') {
          skipped++;
        } else {
          logger.logFailed(entity, `parent:${u.parentId}→${u.id}`, e);
        }
      }
    }

    // childrenIds array
    if (u.childrenIds && Array.isArray(u.childrenIds)) {
      for (const childLegacyId of u.childrenIds) {
        const resolvedChildId = await resolveId('User', childLegacyId);
        if (!resolvedChildId) {
          logger.logSkipped(entity, `${u.id} → child:${childLegacyId}`, 'childId not resolved');
          continue;
        }
        try {
          await prisma.childRelation.upsert({
            where: { parentId_childId: { parentId: parentNewId, childId: resolvedChildId } },
            update: {},
            create: { parentId: parentNewId, childId: resolvedChildId },
          });
          created++;
        } catch (e) {
          if (e.code === 'P2002') {
            skipped++;
          } else {
            logger.logFailed(entity, `child:${childLegacyId}→${u.id}`, e);
          }
        }
      }
    }
  }

  return { created, skipped };
}

async function migrateReferral(legacy, logger, entity) {
  const prisma = getClient();
  let created = 0;
  let skipped = 0;

  // Build referralCode → userId map
  const codeMap = new Map();
  for (const u of legacy) {
    if (u.referralCode) {
      const newId = await resolveId('User', u.id);
      if (newId) codeMap.set(u.referralCode, { newId, legacyId: u.id });
    }
  }

  for (const u of legacy) {
    const referredNewId = await resolveId('User', u.id);
    if (!referredNewId) {
      logger.logSkipped(entity, u.id, 'user not found in IdMapping');
      continue;
    }

    // A) referrals[] array
    if (u.referrals && Array.isArray(u.referrals)) {
      for (const ref of u.referrals) {
        const referrerNewId = await resolveId('User', ref.userId);
        if (!referrerNewId) {
          logger.logSkipped(entity, `${u.id}→ref:${ref.userId}`, 'referrer userId not resolved');
          continue;
        }
        try {
          await prisma.referral.upsert({
            where: { referredId: referredNewId },
            update: {},
            create: {
              referrerId: referrerNewId,
              referredId: referredNewId,
              discount: safeNumber(ref.discount, 25),
              code: u.referralCode || ref.code || '',
              createdAt: safeDate(ref.date) || safeDate(ref.createdAt) || new Date(),
            },
          });
          created++;
        } catch (e) {
          if (e.code === 'P2002') {
            skipped++;
          } else {
            logger.logFailed(entity, `referral:${u.id}→${ref.userId}`, e);
          }
        }
      }
    }

    // B) referredBy fallback
    if (u.referredBy && (!u.referrals || !u.referrals.length)) {
      const referrer = codeMap.get(u.referredBy);
      if (!referrer) {
        logger.logSkipped(entity, `${u.id}→refBy:${u.referredBy}`, 'referrer code not found');
        continue;
      }
      try {
        await prisma.referral.upsert({
          where: { referredId: referredNewId },
          update: {},
          create: {
            referrerId: referrer.newId,
            referredId: referredNewId,
            discount: safeNumber(u.referralDiscount, 25),
            code: u.referredBy,
            createdAt: safeDate(u.referralUsedAt) || new Date(),
          },
        });
        created++;
      } catch (e) {
        if (e.code === 'P2002') {
          skipped++;
        } else {
          logger.logFailed(entity, `referralBy:${u.id}→${u.referredBy}`, e);
        }
      }
    }
  }

  return { created, skipped };
}

async function migrateRelations({ dryRun = false } = {}) {
  const logger = new MigrationLogger(dryRun);
  const legacy = readUsers();

  if (dryRun) {
    return dryRunRelations();
  }

  // Part 1: ChildRelation
  logger.start('ChildRelation');
  const childResult = await migrateChildRelation(legacy, logger, 'ChildRelation');
  logger.done('ChildRelation', childResult.created, childResult.skipped);

  // Part 2: Referral
  logger.start('Referral');
  const refResult = await migrateReferral(legacy, logger, 'Referral');
  logger.done('Referral', refResult.created, refResult.skipped);

  // Verification
  const prisma = getClient();
  const childCount = await prisma.childRelation.count();
  const refCount = await prisma.referral.count();

  return {
    report: logger.report(),
    summary: logger.summary(),
    childCreated: childResult.created,
    childSkipped: childResult.skipped,
    refCreated: refResult.created,
    refSkipped: refResult.skipped,
    childTotal: childCount,
    refTotal: refCount,
  };
}

module.exports = { migrateRelations, dryRunRelations };
