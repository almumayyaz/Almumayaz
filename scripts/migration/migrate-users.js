const { getClient } = require('./client');
const { createMapping, getMappingCount } = require('./id-mapping');
const { readUsers } = require('./legacy-reader');
const { safeDate, safeNumber, safeBoolean, safeString, newCuid, batchInsert } = require('./utils');
const MigrationLogger = require('./logger');

async function dryRunUsers() {
  const legacy = readUsers();
  const emails = new Map();
  const duplicates = [];

  console.log('\n══════════════════════════════════');
  console.log('   USERS — DRY RUN');
  console.log('══════════════════════════════════');

  for (const u of legacy) {
    if (emails.has(u.email)) {
      duplicates.push({ email: u.email, existing: emails.get(u.email), duplicate: u.id });
    } else {
      emails.set(u.email, u.id);
    }
  }

  const invalid = legacy.filter(u => !u.email || !u.name);
  console.log(`  Legacy users found:     ${legacy.length}`);
  console.log(`  Valid records:          ${legacy.length - invalid.length}`);
  console.log(`  Duplicate emails:       ${duplicates.length}`);
  console.log(`  Invalid records:        ${invalid.length}`);
  console.log(`  Unique emails:          ${emails.size}`);

  if (duplicates.length) {
    console.log('\n  Duplicate details:');
    for (const d of duplicates) {
      console.log(`    ~ ${d.email}: kept ${d.existing}, would remove ${d.duplicate}`);
    }
  }

  if (invalid.length) {
    console.log('\n  Invalid records:');
    for (const u of invalid) {
      console.log(`    ✗ ${u.id}: missing ${!u.email ? 'email' : ''} ${!u.name ? 'name' : ''}`);
    }
  }

  return { total: legacy.length, valid: legacy.length - invalid.length, duplicates, invalid };
}

async function migrateUsers({ dryRun = false } = {}) {
  const prisma = getClient();
  const logger = new MigrationLogger(dryRun);
  const entity = 'User';
  logger.start(entity);

  const legacy = readUsers();
  logger.read(entity, legacy.length);

  if (dryRun) {
    await dryRunUsers();
    logger.done(entity, 0, legacy.length);
    return logger.report();
  }

  const emails = new Map();
  const skipIds = new Set();
  const created = [];

  for (const u of legacy) {
    if (!u.email || !u.name) {
      logger.logSkipped(entity, u.id, 'missing required fields');
      skipIds.add(u.id);
      continue;
    }

    if (emails.has(u.email)) {
      const existingCreated = new Date(emails.get(u.email).createdAt || 0).getTime();
      const currentCreated = new Date(u.createdAt || 0).getTime();
      if (currentCreated > existingCreated) {
        skipIds.add(u.id);
        logger.logDuplicate(entity, u.email, emails.get(u.email).id, u.id);
      } else {
        skipIds.add(emails.get(u.email).id);
        logger.logDuplicate(entity, u.email, u.id, emails.get(u.email).id);
        emails.set(u.email, u);
      }
      continue;
    }
    emails.set(u.email, u);

    try {
      const newId = newCuid();
      const userData = {
        id: newId,
        uid: safeString(u.uid, ''),
        name: safeString(u.name),
        email: u.email,
        passwordHash: u.password || u.passwordHash || null,
        role: safeString(u.role, 'student'),
        phone: safeString(u.phone),
        parentName: safeString(u.parentName),
        parentPhone: safeString(u.parentPhone),
        parentEmail: safeString(u.parentEmail),
        parentId: u.parentId || null,
        parentStudentId: u.parentStudentId || null,
        childrenIds: u.childrenIds ? JSON.parse(JSON.stringify(u.childrenIds)) : '[]',
        parentOf: u.parentOf ? JSON.parse(JSON.stringify(u.parentOf)) : '[]',
        stage: safeString(u.stage),
        grade: safeString(u.grade),
        governorate: safeString(u.governorate),
        avatar: safeString(u.avatar),
        fcmEnabled: safeBoolean(u.fcmEnabled, true),
        notes: safeString(u.notes),
        subscriptionStatus: safeString(u.subscriptionStatus, 'inactive'),
        subscriptionStart: safeDate(u.subscriptionStart),
        subscriptionEnd: safeDate(u.subscriptionEnd),
        subscribedStage: safeString(u.subscribedStage),
        planName: safeString(u.planName),
        planPeriod: safeString(u.planPeriod),
        referralCode: safeString(u.referralCode),
        referredBy: u.referredBy || null,
        referralDiscount: safeNumber(u.referralDiscount, 0),
        referralUsedAt: safeDate(u.referralUsedAt),
        referrals: u.referrals ? JSON.parse(JSON.stringify(u.referrals)) : '[]',
        fcmToken: safeString(u.fcmToken),
        emailVerified: safeBoolean(u.emailVerified, false),
        emailCode: u.emailCode || null,
        emailCodeExpiry: safeDate(u.emailCodeExpiry),
        resetCode: u.resetCode || null,
        resetCodeExpiry: safeDate(u.resetCodeExpiry),
        createdAt: safeDate(u.createdAt) || safeDate(u.created_at) || new Date(),
        updatedAt: safeDate(u.updatedAt) || safeDate(u.updated_at) || new Date(),
        lastLogin: safeDate(u.lastLogin),
        phoneVerified: safeBoolean(u.phoneVerified, false),
        phoneVerifiedAt: safeDate(u.phoneVerifiedAt),
        progress: u.progress ? JSON.parse(JSON.stringify(u.progress)) : '{}',
        deletedAt: safeDate(u.deletedAt),
        deletedBy: u.deletedBy || null,
      };

      await prisma.user.create({ data: userData });
      await createMapping('User', u.id, newId);
      logger.logCreated(entity, u.id, newId);
      created.push(u.id);
    } catch (e) {
      logger.logFailed(entity, u.id, e);
      console.error(`  Code: ${e.code || 'N/A'}`);
      if (e.meta) console.error(`  Meta: ${JSON.stringify(e.meta)}`);
      if (e.message) console.error(`  Msg: ${e.message.substring(0, 500)}`);
    }
  }

  logger.found(entity, legacy.length);
  logger.existing(entity, 0);
  logger.done(entity, created.length, legacy.length - created.length - skipIds.size);

  const mappingCount = await getMappingCount();
  const dbCount = await prisma.user.count();

  return {
    report: logger.report(),
    summary: logger.summary(),
    legacyCount: legacy.length,
    dbCount,
    createdCount: created.length,
    mappingCount,
    skipCount: skipIds.size,
  };
}

module.exports = { migrateUsers, dryRunUsers };
