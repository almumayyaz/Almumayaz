require('dotenv').config();
const { Pool } = require('pg');

async function auditFK() {
  const pool = new Pool({ connectionString: process.env.DIRECT_URL });

  console.log('\n═══════════════════════════════════════════');
  console.log('  FOREIGN KEY AUDIT');
  console.log('═══════════════════════════════════════════\n');

  const checks = [
    { name: 'UserSubscription orphans (no User)', sql: 'SELECT COUNT(*) FROM "UserSubscription" us LEFT JOIN "User" u ON u.id = us."userId" WHERE u.id IS NULL' },
    { name: 'LessonProgress orphans (no User)', sql: 'SELECT COUNT(*) FROM "LessonProgress" lp LEFT JOIN "User" u ON u.id = lp."studentId" WHERE u.id IS NULL' },
    { name: 'LessonProgress orphans (no Lesson)', sql: 'SELECT COUNT(*) FROM "LessonProgress" lp LEFT JOIN "Lesson" l ON l.id = lp."lessonId" WHERE l.id IS NULL' },
    { name: 'VideoProgress orphans (no User)', sql: 'SELECT COUNT(*) FROM "VideoProgress" vp LEFT JOIN "User" u ON u.id = vp."studentId" WHERE u.id IS NULL' },
    { name: 'VideoProgress orphans (no Lesson)', sql: 'SELECT COUNT(*) FROM "VideoProgress" vp LEFT JOIN "Lesson" l ON l.id = vp."lessonId" WHERE l.id IS NULL' },
    { name: 'VideoProgress orphans (no Video)', sql: 'SELECT COUNT(*) FROM "VideoProgress" vp LEFT JOIN "Video" v ON v.id = vp."videoId" WHERE v.id IS NULL' },
    { name: 'Lesson orphans (no Course)', sql: 'SELECT COUNT(*) FROM "Lesson" l LEFT JOIN "Course" c ON c.id = l."courseId" WHERE c.id IS NULL' },
    { name: 'Video orphans (no Lesson)', sql: 'SELECT COUNT(*) FROM "Video" v LEFT JOIN "Lesson" l ON l.id = v."lessonId" WHERE l.id IS NULL' },
    { name: 'LessonFile orphans (no Lesson)', sql: 'SELECT COUNT(*) FROM "LessonFile" f LEFT JOIN "Lesson" l ON l.id = f."lessonId" WHERE l.id IS NULL' },
    { name: 'Quiz orphans (no lesson entity)', sql: 'SELECT COUNT(*) FROM "Quiz" q LEFT JOIN "Lesson" l ON l.id = q."entityId" AND q."entityType" = \'lesson\' WHERE l.id IS NULL' },
    { name: 'Question orphans (no Quiz)', sql: 'SELECT COUNT(*) FROM "Question" q LEFT JOIN "Quiz" qz ON qz.id = q."quizId" WHERE qz.id IS NULL' },
    { name: 'Choice orphans (no Question)', sql: 'SELECT COUNT(*) FROM "Choice" c LEFT JOIN "Question" q ON q.id = c."questionId" WHERE q.id IS NULL' },
    { name: 'ExamAttempt orphans (no User)', sql: 'SELECT COUNT(*) FROM "ExamAttempt" ea LEFT JOIN "User" u ON u.id = ea."userId" WHERE u.id IS NULL' },
    { name: 'ExamAttempt orphans (no Course)', sql: 'SELECT COUNT(*) FROM "ExamAttempt" ea LEFT JOIN "Course" c ON c.id = ea."courseId" WHERE c.id IS NULL AND ea."courseId" IS NOT NULL' },
    { name: 'Enrollment orphans (no User)', sql: 'SELECT COUNT(*) FROM "Enrollment" e LEFT JOIN "User" u ON u.id = e."userId" WHERE u.id IS NULL' },
    { name: 'Enrollment orphans (no Course)', sql: 'SELECT COUNT(*) FROM "Enrollment" e LEFT JOIN "Course" c ON c.id = e."courseId" WHERE c.id IS NULL' },
    { name: 'ChildRelation orphans (no parent)', sql: 'SELECT COUNT(*) FROM "ChildRelation" cr LEFT JOIN "User" u ON u.id = cr."parentId" WHERE u.id IS NULL' },
    { name: 'ChildRelation orphans (no child)', sql: 'SELECT COUNT(*) FROM "ChildRelation" cr LEFT JOIN "User" u ON u.id = cr."childId" WHERE u.id IS NULL' },
    { name: 'Referral orphans (no referrer)', sql: 'SELECT COUNT(*) FROM "Referral" r LEFT JOIN "User" u ON u.id = r."referrerId" WHERE u.id IS NULL' },
    { name: 'Referral orphans (no referred)', sql: 'SELECT COUNT(*) FROM "Referral" r LEFT JOIN "User" u ON u.id = r."referredId" WHERE u.id IS NULL' },
    { name: 'QuestionBank orphans (no Course)', sql: 'SELECT COUNT(*) FROM "QuestionBank" qb LEFT JOIN "Course" c ON c.id = qb."courseId" WHERE c.id IS NULL' },
    { name: 'Unit orphans (no Course)', sql: 'SELECT COUNT(*) FROM "Unit" u LEFT JOIN "Course" c ON c.id = u."courseId" WHERE c.id IS NULL' },
  ];

  let allOk = true;
  for (const check of checks) {
    const r = await pool.query(check.sql);
    const count = parseInt(r.rows[0].count, 10);
    const status = count === 0 ? 'OK' : 'ORPHAN';
    if (count > 0) allOk = false;
    console.log('  [' + status + '] ' + check.name + ': ' + count);
  }

  console.log(allOk ? '\n  All FK relationships valid - no orphan records' : '\n  WARNING: Some orphan records found');
  console.log('═══════════════════════════════════════════\n');
  await pool.end();
  process.exit(allOk ? 0 : 1);
}
auditFK();
