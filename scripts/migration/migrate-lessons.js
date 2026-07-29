const { getClient } = require('./client');
const { createMapping, resolveId, getMappingCount } = require('./id-mapping');
const { readCourses } = require('./legacy-reader');
const { getLegacySectionMap } = require('./migrate-units');
const { safeDate, safeNumber, safeBoolean, safeString, newCuid } = require('./utils');
const MigrationLogger = require('./logger');

async function dryRunLessons() {
  const legacy = readCourses();
  let lessonCount = 0;
  let videoCount = 0;
  let fileCount = 0;
  const lessonIds = new Set();
  const dups = [];
  let orphans = 0;

  for (const c of legacy) {
    if (!c.lessons || !Array.isArray(c.lessons)) continue;
    for (const l of c.lessons) {
      if (!l.id) continue;
      if (lessonIds.has(l.id)) dups.push(l.id);
      lessonIds.add(l.id);
      lessonCount++;
      if (l.videos && Array.isArray(l.videos)) videoCount += l.videos.length;
      if (l.pdfFiles && Array.isArray(l.pdfFiles)) fileCount += l.pdfFiles.length;
    }
  }

  console.log('\n══════════════════════════════════');
  console.log('   LESSONS — DRY RUN');
  console.log('══════════════════════════════════');
  console.log(`  Legacy lessons:        ${lessonCount}`);
  console.log(`  Legacy videos:         ${videoCount}`);
  console.log(`  Legacy files:          ${fileCount}`);
  console.log(`  Duplicate lesson IDs:  ${dups.length}`);
  console.log(`  Orphan lessons:        ${orphans}`);

  if (dups.length) {
    console.log('\n  Duplicate IDs:');
    for (const d of dups) console.log(`    ~ ${d}`);
  }

  return { lessonCount, videoCount, fileCount, dups, orphans };
}

async function migrateLessons({ dryRun = false } = {}) {
  const prisma = getClient();
  const logger = new MigrationLogger(dryRun);
  const sectionMap = getLegacySectionMap();

  if (dryRun) {
    logger.start('Lesson');
    const result = await dryRunLessons();
    logger.done('Lesson', 0, result.lessonCount);
    logger.start('Video');
    logger.read('Video', result.videoCount);
    logger.done('Video', 0, result.videoCount);
    logger.start('LessonFile');
    logger.read('LessonFile', result.fileCount);
    logger.done('LessonFile', 0, result.fileCount);
    return logger.report();
  }

  logger.start('Lesson');
  logger.start('Video');
  logger.start('LessonFile');

  const legacy = readCourses();
  let lessonTotal = 0;
  let videoTotal = 0;
  let fileTotal = 0;
  for (const c of legacy) {
    if (!c.lessons || !Array.isArray(c.lessons)) continue;
    lessonTotal += c.lessons.length;
    for (const l of c.lessons) {
      if (l.videos) videoTotal += l.videos.length;
      if (l.pdfFiles) fileTotal += l.pdfFiles.length;
    }
  }
  logger.read('Lesson', lessonTotal);
  logger.read('Video', videoTotal);
  logger.read('LessonFile', fileTotal);

  let lessonCreated = 0;
  let videoCreated = 0;
  let fileCreated = 0;
  let lessonSkipped = 0;

  for (const c of legacy) {
    const courseNewId = await resolveId('Course', c.id);
    if (!courseNewId) {
      if (c.lessons && Array.isArray(c.lessons)) {
        for (const l of c.lessons) {
          logger.logSkipped('Lesson', l.id, 'course not in IdMapping');
          lessonSkipped++;
        }
      }
      continue;
    }

    if (!c.lessons || !Array.isArray(c.lessons)) continue;

    for (const l of c.lessons) {
      if (!l.title) {
        logger.logSkipped('Lesson', l.id || 'unknown', 'missing title');
        lessonSkipped++;
        continue;
      }

      try {
        const newLessonId = newCuid();

        let unitId = null;
        if (l.sectionId && sectionMap.has(l.sectionId)) {
          unitId = sectionMap.get(l.sectionId);
        }

        await prisma.lesson.create({
          data: {
            id: newLessonId,
            courseId: courseNewId,
            unitId: unitId,
            title: safeString(l.title),
            description: safeString(l.description),
            duration: safeString(l.duration, '00:00'),
            order: safeNumber(l.order, 0),
            isFree: safeBoolean(l.isFree, false),
            guestVisible: safeBoolean(l.guestVisible, false),
            sectionId: safeString(l.sectionId),
            videos: l.videos || '[]',
            pdfFiles: l.pdfFiles || '[]',
            quiz: l.quiz || null,
            createdAt: safeDate(l.createdAt) || new Date(),
            updatedAt: safeDate(l.updatedAt) || new Date(),
            deletedAt: null,
            deletedBy: null,
          },
        });

        await createMapping('Lesson', l.id, newLessonId);
        logger.logCreated('Lesson', l.id, newLessonId);
        lessonCreated++;

        // Videos
        if (l.videos && Array.isArray(l.videos)) {
          for (let vi = 0; vi < l.videos.length; vi++) {
            const v = l.videos[vi];
            try {
              await prisma.video.create({
                data: {
                  lessonId: newLessonId,
                  order: vi,
                  title: safeString(v.title),
                  url: safeString(v.url || v.src || ''),
                  duration: v.duration ? Number(v.duration) : null,
                  thumbnail: v.thumbnail || null,
                  isPreview: safeBoolean(v.isPreview, false),
                  createdAt: safeDate(v.createdAt) || new Date(),
                  updatedAt: safeDate(v.updatedAt) || new Date(),
                  deletedAt: null,
                  deletedBy: null,
                },
              });
              videoCreated++;
            } catch (e) {
              logger.logFailed('Video', `${l.id}:video:${vi}`, e);
            }
          }
        }

        // PDF Files
        if (l.pdfFiles && Array.isArray(l.pdfFiles)) {
          for (let fi = 0; fi < l.pdfFiles.length; fi++) {
            const f = l.pdfFiles[fi];
            try {
              await prisma.lessonFile.create({
                data: {
                  lessonId: newLessonId,
                  order: fi,
                  title: safeString(f.title || f.name),
                  url: safeString(f.url || ''),
                  filePath: safeString(f.filePath),
                  type: safeString(f.type, 'pdf'),
                  size: f.size ? Number(f.size) : null,
                  createdAt: safeDate(f.createdAt) || new Date(),
                  updatedAt: safeDate(f.updatedAt) || new Date(),
                  deletedAt: null,
                  deletedBy: null,
                },
              });
              fileCreated++;
            } catch (e) {
              logger.logFailed('LessonFile', `${l.id}:file:${fi}`, e);
            }
          }
        }
      } catch (e) {
        logger.logFailed('Lesson', l.id, e);
      }
    }
  }

  logger.found('Lesson', lessonTotal);
  logger.found('Video', videoTotal);
  logger.found('LessonFile', fileTotal);
  logger.done('Lesson', lessonCreated, lessonSkipped);
  logger.done('Video', videoCreated, videoTotal - videoCreated);
  logger.done('LessonFile', fileCreated, fileTotal - fileCreated);

  const dbLessonCount = await prisma.lesson.count();
  const dbVideoCount = await prisma.video.count();
  const dbFileCount = await prisma.lessonFile.count();
  const lessonMappingCount = await prisma.idMapping.count({
    where: { entityType: 'Lesson' },
  });

  return {
    report: logger.report(),
    summary: logger.summary(),
    legacyLessons: lessonTotal,
    legacyVideos: videoTotal,
    legacyFiles: fileTotal,
    dbLessons: dbLessonCount,
    dbVideos: dbVideoCount,
    dbFiles: dbFileCount,
    lessonCreated,
    videoCreated,
    fileCreated,
    lessonSkipped,
    lessonMappingCount,
  };
}

module.exports = { migrateLessons, dryRunLessons };
