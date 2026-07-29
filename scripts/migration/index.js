const { disconnect } = require('./client');
const { migrateUsers, dryRunUsers } = require('./migrate-users');
const { migrateRelations, dryRunRelations } = require('./migrate-relations');
const { migrateCourses, dryRunCourses } = require('./migrate-courses');
const { migrateUnits, dryRunUnits } = require('./migrate-units');
const { migrateLessons, dryRunLessons } = require('./migrate-lessons');
const { migrateQuizzes, dryRunQuizzes } = require('./migrate-quizzes');
const { migrateConfig, dryRunConfig } = require('./migrate-config');
const { migrateUserSubscriptions, dryRunUserSubscriptions } = require('./migrate-user-subscriptions');
const { migrateUserProgress, dryRunUserProgress } = require('./migrate-user-progress');
const { migrateExams, dryRunExams } = require('./migrate-exams');
const { migrateRemainingL0, dryRunRemainingL0 } = require('./migrate-remaining-l0');
const { migrateRemainingL1, dryRunRemainingL1 } = require('./migrate-remaining-l1');
const { migratePayments, dryRunPayments } = require('./migrate-payments');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const phase = args.find(a => a.startsWith('--phase='))?.split('=')[1] || 'users';

async function main() {
  console.log('══════════════════════════════════');
  console.log(`  MIGRATION RUNNER`);
  console.log(`  Phase: ${phase}`);
  console.log(`  Mode:  ${isDryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('══════════════════════════════════\n');

  try {
    let result;

    switch (phase) {
      case 'users':
        result = await migrateUsers({ dryRun: isDryRun });
        break;
      case 'relations':
        result = await migrateRelations({ dryRun: isDryRun });
        break;
      case 'courses':
        result = await migrateCourses({ dryRun: isDryRun });
        break;
      case 'units':
        result = await migrateUnits({ dryRun: isDryRun });
        break;
      case 'lessons':
        result = await migrateLessons({ dryRun: isDryRun });
        break;
      case 'quizzes':
        result = await migrateQuizzes({ dryRun: isDryRun });
        break;
      case 'config':
        result = await migrateConfig({ dryRun: isDryRun });
        break;
      case 'user-subscriptions':
        result = await migrateUserSubscriptions({ dryRun: isDryRun });
        break;
      case 'user-progress':
        result = await migrateUserProgress({ dryRun: isDryRun });
        break;
      case 'exams':
        result = await migrateExams({ dryRun: isDryRun });
        break;
      case 'remaining-l0':
        result = await migrateRemainingL0({ dryRun: isDryRun });
        break;
      case 'remaining-l1':
        result = await migrateRemainingL1({ dryRun: isDryRun });
        break;
      case 'payments':
        result = await migratePayments({ dryRun: isDryRun });
        break;
      case 'dry-run-users':
        result = await dryRunUsers();
        break;
      case 'dry-run-relations':
        result = await dryRunRelations();
        break;
      case 'dry-run-courses':
        result = await dryRunCourses();
        break;
      case 'dry-run-units':
        result = await dryRunUnits();
        break;
      case 'dry-run-lessons':
        result = await dryRunLessons();
        break;
      case 'dry-run-quizzes':
        result = await dryRunQuizzes();
        break;
      case 'dry-run-config':
        result = await dryRunConfig();
        break;
      case 'dry-run-user-subscriptions':
        result = await dryRunUserSubscriptions();
        break;
      case 'dry-run-user-progress':
        result = await dryRunUserProgress();
        break;
      case 'dry-run-exams':
        result = await dryRunExams();
        break;
      case 'dry-run-remaining-l0':
        result = await dryRunRemainingL0();
        break;
      case 'dry-run-remaining-l1':
        result = await dryRunRemainingL1();
        break;
      case 'dry-run-payments':
        result = await dryRunPayments();
        break;
      default:
        console.error(`Unknown phase: ${phase}`);
        console.log('Available phases: users, relations, courses, units, lessons, payments');
        process.exit(1);
    }

    if (!isDryRun && result) {
      console.log('\n══════════════════════════════════');
      console.log('  VERIFICATION');
      console.log('══════════════════════════════════');

      if (result.entities && result.dbCounts) {
        let allOk = true;
        for (const entity of result.entities) {
          const count = result.dbCounts[entity] || 0;
          console.log(`  ${entity}: ${count} row(s)`);
          if (count > 0) allOk = false;
        }
        console.log(allOk ? '  ✅ Zero-data models verified (0 rows expected)' : '  ⚠ Unexpected data in zero-data models');
      } else if (result.childTotal !== undefined) {
        console.log(`  ChildRelation created: ${result.childCreated}`);
        console.log(`  ChildRelation skipped: ${result.childSkipped}`);
        console.log(`  Referral created:      ${result.refCreated}`);
        console.log(`  Referral skipped:      ${result.refSkipped}`);
        console.log(`  ChildRelation total:   ${result.childTotal}`);
        console.log(`  Referral total:        ${result.refTotal}`);
        console.log('  ✅ Relations migration complete');
      } else if (result.dbAttempts !== undefined) {
        console.log(`  Legacy exam attempts: ${result.legacyAttempts}`);
        console.log(`  DB exam attempts:     ${result.dbAttempts}`);
        console.log(`  Attempts created:     ${result.attemptCreated}`);
        console.log(`  Attempts skipped:     ${result.attemptSkipped}`);
        console.log(`  Legacy exam answers:  ${result.legacyAnswers}`);
        console.log(`  DB exam answers:      ${result.dbAnswers}`);
        if (result.legacyAttempts === result.dbAttempts) {
          console.log('  ✅ Exam attempts migrated successfully');
        } else {
          console.log('  ⚠ Count mismatch — check logs');
        }
      } else if (result.dbLp !== undefined) {
        console.log(`  Legacy lesson progress: ${result.legacyLp}`);
        console.log(`  DB lesson progress:     ${result.dbLp}`);
        console.log(`  LessonProgress created: ${result.lpCreated}`);
        console.log(`  LessonProgress skipped: ${result.lpSkipped}`);
        console.log(`  Legacy video progress:  ${result.legacyVp}`);
        console.log(`  DB video progress:      ${result.dbVp}`);
        if (result.legacyLp === result.dbLp) {
          console.log('  ✅ Lesson progress migrated successfully');
        } else {
          console.log('  ⚠ Count mismatch — check logs');
        }
      } else if (result.dbSettings !== undefined) {
        console.log(`  Settings keys:     ${result.legacySettings}`);
        console.log(`  DB settings:       ${result.dbSettings}`);
        console.log(`  Settings created:  ${result.settingCreated}`);
        console.log(`  Settings skipped:  ${result.settingSkipped}`);
        console.log(`  ZoomAppCred:       ${result.legacyZoom > 0 ? 'present' : 'absent'} → ${result.dbZoom > 0 ? 'present' : 'absent'}`);
        console.log(`  SchedNotif legacy: ${result.legacySnots}`);
        console.log(`  SchedNotif DB:     ${result.dbSnots}`);
        console.log(`  SchedNotif created:${result.snotCreated}`);
        console.log(`  SchedNotif skipped:${result.snotSkipped}`);
        if (result.settingSkipped + result.snotSkipped === 0) {
          console.log('  ✅ Config models migrated successfully');
        } else {
          console.log('  ⚠ Some config models skipped — check logs');
        }
      } else if (result.dbQuizzes !== undefined) {
        console.log(`  Legacy quizzes:    ${result.legacyQuizzes}`);
        console.log(`  DB quizzes:        ${result.dbQuizzes}`);
        console.log(`  Legacy questions:  ${result.legacyQuestions}`);
        console.log(`  DB questions:      ${result.dbQuestions}`);
        console.log(`  Legacy choices:    ${result.legacyChoices}`);
        console.log(`  DB choices:        ${result.dbChoices}`);
        console.log(`  Quizzes created:   ${result.quizCreated}`);
        console.log(`  Questions created: ${result.questionCreated}`);
        console.log(`  Choices created:   ${result.choiceCreated}`);
        console.log(`  Skipped:           ${result.quizSkipped}`);

        if (result.legacyQuizzes === result.dbQuizzes) {
          console.log('  ✅ All quizzes migrated successfully');
        } else {
          console.log('  ⚠ Count mismatch — check logs above');
        }
      } else if (result.dbLessons !== undefined) {
        console.log(`  Legacy lessons:    ${result.legacyLessons}`);
        console.log(`  DB lessons:        ${result.dbLessons}`);
        console.log(`  Legacy videos:     ${result.legacyVideos}`);
        console.log(`  DB videos:         ${result.dbVideos}`);
        console.log(`  Legacy files:      ${result.legacyFiles}`);
        console.log(`  DB files:          ${result.dbFiles}`);
        console.log(`  Lessons created:   ${result.lessonCreated}`);
        console.log(`  Videos created:    ${result.videoCreated}`);
        console.log(`  Files created:     ${result.fileCreated}`);
        console.log(`  Lesson IdMappings: ${result.lessonMappingCount}`);
        console.log(`  Skipped:           ${result.lessonSkipped}`);

        if (result.legacyLessons === result.dbLessons) {
          console.log('  ✅ All lessons migrated successfully');
        } else {
          console.log('  ⚠ Count mismatch — check logs above');
        }
      } else if (result.legacyCount !== undefined && result.dbCount !== undefined) {
        console.log(`  Legacy count:    ${result.legacyCount}`);
        console.log(`  DB count:        ${result.dbCount}`);
        console.log(`  Created:         ${result.createdCount}`);
        console.log(`  Skipped:         ${result.skipCount}`);

        if (result.legacyCount === result.dbCount) {
          console.log('  ✅ All records migrated successfully');
        } else {
          console.log('  ⚠ Count mismatch — check logs above');
        }
      }
    }
  } catch (e) {
    console.error('Migration failed:', e);
    process.exit(1);
  } finally {
    await disconnect();
  }
}

main();
