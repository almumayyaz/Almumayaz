const { getClient } = require('./client');
const { createMapping, getMappingCount } = require('./id-mapping');
const { readCourses } = require('./legacy-reader');
const { safeDate, safeNumber, safeBoolean, safeString, newCuid } = require('./utils');
const MigrationLogger = require('./logger');

async function dryRunCourses() {
  const legacy = readCourses();
  const invalid = legacy.filter(c => !c.title);
  const ids = new Set();
  const dups = [];
  for (const c of legacy) {
    if (ids.has(c.id)) dups.push(c.id);
    ids.add(c.id);
  }

  console.log('\n══════════════════════════════════');
  console.log('   COURSES — DRY RUN');
  console.log('══════════════════════════════════');
  console.log(`  Legacy courses:    ${legacy.length}`);
  console.log(`  Valid courses:     ${legacy.length - invalid.length}`);
  console.log(`  Invalid (no title): ${invalid.length}`);
  console.log(`  Duplicate IDs:     ${dups.length}`);

  if (dups.length) {
    console.log('\n  Duplicate IDs:');
    for (const d of dups) console.log(`    ~ ${d}`);
  }

  return { total: legacy.length, valid: legacy.length - invalid.length, invalid, dups };
}

async function migrateCourses({ dryRun = false } = {}) {
  const prisma = getClient();
  const logger = new MigrationLogger(dryRun);
  const entity = 'Course';
  logger.start(entity);

  const legacy = readCourses();
  logger.read(entity, legacy.length);

  if (dryRun) {
    await dryRunCourses();
    logger.done(entity, 0, legacy.length);
    return logger.report();
  }

  let createdCount = 0;
  let skipCount = 0;

  for (const c of legacy) {
    if (!c.title) {
      logger.logSkipped(entity, c.id || 'unknown', 'missing title');
      skipCount++;
      continue;
    }

    try {
      const newId = newCuid();

      await prisma.course.create({
        data: {
          id: newId,
          title: safeString(c.title),
          subtitle: safeString(c.subtitle),
          description: safeString(c.description),
          icon: safeString(c.icon, 'fa-book'),
          color: safeString(c.color, '#A07200'),
          gradient: safeString(c.gradient),
          image: c.image || null,
          stage: safeString(c.stage, 'all'),
          grade: safeString(c.grade),
          semester: safeString(c.semester, 'all'),
          order: safeNumber(c.order, 0),
          active: safeBoolean(c.active, true),
          guestVisible: safeBoolean(c.guestVisible, false),
          price: c.price ? safeNumber(c.price, null) : null,
          sections: c.sections || '[]',
          quiz: c.quiz || null,
          createdAt: safeDate(c.createdAt) || new Date(),
          updatedAt: safeDate(c.updatedAt) || new Date(),
          deletedAt: c.deletedAt ? safeDate(c.deletedAt) : null,
          deletedBy: c.deletedBy || null,
        },
      });

      await createMapping('Course', c.id, newId);
      logger.logCreated(entity, c.id, newId);
      createdCount++;
    } catch (e) {
      logger.logFailed(entity, c.id, e);
    }
  }

  logger.found(entity, legacy.length);
  logger.done(entity, createdCount, skipCount);

  const mappingCount = await getMappingCount();
  const dbCount = await prisma.course.count();

  return {
    report: logger.report(),
    summary: logger.summary(),
    legacyCount: legacy.length,
    dbCount,
    createdCount,
    mappingCount,
    skipCount,
  };
}

module.exports = { migrateCourses, dryRunCourses };
