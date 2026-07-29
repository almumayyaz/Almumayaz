const { getClient } = require('./client');
const { resolveId } = require('./id-mapping');
const { readCourses } = require('./legacy-reader');
const { safeDate, safeString, newCuid } = require('./utils');
const MigrationLogger = require('./logger');

const legacySectionToUnit = new Map();

function getLegacySectionMap() {
  return legacySectionToUnit;
}

async function dryRunUnits() {
  const legacy = readCourses();
  let totalSections = 0;
  let coursesWithSections = 0;
  let orphanCourses = 0;
  const sectionIds = new Set();
  const dupSectionIds = [];

  for (const c of legacy) {
    const sections = c.sections;
    if (!sections || !Array.isArray(sections) || !sections.length) continue;

    coursesWithSections++;
    totalSections += sections.length;

    for (const s of sections) {
      if (s.id && sectionIds.has(s.id)) dupSectionIds.push(s.id);
      if (s.id) sectionIds.add(s.id);
    }
  }

  console.log('\n══════════════════════════════════');
  console.log('   UNITS — DRY RUN');
  console.log('══════════════════════════════════');
  console.log(`  Courses with sections:   ${coursesWithSections}`);
  console.log(`  Total sections (Units):  ${totalSections}`);
  console.log(`  Orphan courses:          ${orphanCourses}`);
  console.log(`  Duplicate section IDs:   ${dupSectionIds.length}`);

  if (dupSectionIds.length) {
    console.log('\n  Duplicate section IDs:');
    for (const d of dupSectionIds) console.log(`    ~ ${d}`);
  }

  return { coursesWithSections, totalSections, orphanCourses, dupSectionIds };
}

async function migrateUnits({ dryRun = false } = {}) {
  const prisma = getClient();
  const logger = new MigrationLogger(dryRun);
  const entity = 'Unit';
  logger.start(entity);

  const legacy = readCourses();
  let sectionsCount = 0;
  for (const c of legacy) {
    if (c.sections && Array.isArray(c.sections)) sectionsCount += c.sections.length;
  }
  logger.read(entity, sectionsCount);

  if (dryRun) {
    await dryRunUnits();
    logger.done(entity, 0, sectionsCount);
    return logger.report();
  }

  let createdCount = 0;
  let skipCount = 0;

  for (const c of legacy) {
    const courseNewId = await resolveId('Course', c.id);
    if (!courseNewId) {
      logger.logSkipped(entity, c.id, 'course not found in IdMapping');
      skipCount++;
      continue;
    }

    const sections = c.sections;
    if (!sections || !Array.isArray(sections) || !sections.length) continue;

    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      try {
        const newId = newCuid();
        await prisma.unit.create({
          data: {
            id: newId,
            courseId: courseNewId,
            title: safeString(s.name || s.title || `Unit ${i + 1}`),
            description: safeString(s.description),
            order: s.order !== undefined ? Number(s.order) : i,
            createdAt: safeDate(s.createdAt) || new Date(),
            updatedAt: safeDate(s.updatedAt) || new Date(),
            deletedAt: null,
            deletedBy: null,
          },
        });

        if (s.id) {
          legacySectionToUnit.set(s.id, newId);
        }

        logger.logCreated(entity, s.id || `${c.id}:section:${i}`, newId);
        createdCount++;
      } catch (e) {
        logger.logFailed(entity, s.id || `${c.id}:section:${i}`, e);
      }
    }
  }

  logger.found(entity, sectionsCount);
  logger.done(entity, createdCount, skipCount);

  const dbCount = await prisma.unit.count();

  return {
    report: logger.report(),
    summary: logger.summary(),
    legacyCount: sectionsCount,
    dbCount,
    createdCount,
    skipCount,
  };
}

module.exports = { migrateUnits, dryRunUnits, getLegacySectionMap };
