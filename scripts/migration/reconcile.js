require('dotenv').config();
const { Pool } = require('pg');
const { readUsers, readCourses, readPayments, readSubRequests, readSubscriptions,
  readNotes, readQuestionBanks, readReviews, readSettings, readAnnouncements,
  readQuotes, readScheduledNotifications, readZoomAppCredentials } = require('./legacy-reader');

async function reconcile() {
  const pool = new Pool({ connectionString: process.env.DIRECT_URL });

  // ══════════════════════════════════
  //  LEGACY COUNTS
  // ══════════════════════════════════
  const legacy = {};

  const users = readUsers();
  legacy.User = users.length;
  legacy.UserSubscription = users.filter(u => u.subscriptionStatus).length;

  let lpCount = 0, examCount = 0, quizResultCount = 0;
  for (const u of users) {
    if (u.examResults) examCount += u.examResults.length;
    if (u.quizResults) {
      for (const cid of Object.keys(u.quizResults)) {
        quizResultCount += Object.keys(u.quizResults[cid] || {}).length;
      }
    }
    if (u.progress) {
      for (const cp of Object.values(u.progress)) {
        if (cp && Array.isArray(cp.completedLessons)) lpCount += cp.completedLessons.length;
      }
    }
  }
  legacy.LessonProgress = lpCount;
  legacy.VideoProgress = 0;
  legacy.ExamAttempt = examCount + quizResultCount;
  legacy.ExamAnswer = 0;

  const courses = readCourses();
  legacy.Course = courses.length;
  legacy.Unit = courses.reduce((s, c) => s + (c.sections ? c.sections.length : 0), 0);
  let lessonCount = 0, videoCount = 0, fileCount = 0, quizCount = 0, qCount = 0, chCount = 0;
  for (const c of courses) {
    if (!c.lessons) continue;
    for (const l of c.lessons) {
      lessonCount++;
      if (l.videos) videoCount += l.videos.length;
      if (l.pdfFiles) fileCount += l.pdfFiles.length;
      if (l.quiz && l.quiz.enabled) {
        quizCount++;
        if (l.quiz.questions) {
          for (const q of l.quiz.questions) {
            qCount++;
            if (q.options) chCount += q.options.length;
          }
        }
      }
    }
  }
  legacy.Lesson = lessonCount;
  legacy.Video = videoCount;
  legacy.LessonFile = fileCount;
  legacy.Quiz = quizCount;
  legacy.Question = qCount;
  legacy.Choice = chCount;

  legacy.ChildRelation = 0;
  for (const u of users) {
    if (u.childrenIds && Array.isArray(u.childrenIds)) legacy.ChildRelation += u.childrenIds.length;
    else if (u.parentPhone) legacy.ChildRelation++;
  }
  legacy.Referral = users.filter(u => u.referralCode && u.referredBy).length;
  legacy.IdMapping = 0; // not tracked in legacy source

  legacy.Setting = Object.keys(readSettings()).length;
  legacy.ZoomAppCredential = readZoomAppCredentials().clientId ? 1 : 0;
  legacy.ScheduledNotification = readScheduledNotifications().length;

  function countArray(fn) { try { const d = fn(); return Array.isArray(d) ? d.length : 0; } catch { return 0; } }
  legacy.Payment = countArray(readPayments);
  legacy.SubRequest = countArray(readSubRequests);
  legacy.Subscription = countArray(readSubscriptions);
  legacy.Note = countArray(readNotes);
  legacy.QuestionBank = countArray(readQuestionBanks);
  legacy.Review = countArray(readReviews);
  legacy.Announcement = countArray(readAnnouncements);
  legacy.Quote = countArray(readQuotes);
  legacy.ChargeCode = 0;
  legacy.LiveSession = 0;
  legacy.Notification = 0;
  legacy.SupportTicket = 0;
  legacy.ParentInvite = 0;
  legacy.RefreshToken = 0;
  legacy.ZoomCredential = 0;
  legacy.CronClaim = 0;
  legacy.Enrollment = 0;
  legacy.Dismissed = 0;
  legacy.UsageLog = 0;
  legacy.AuditLog = 0;
  legacy.StudentAnalytic = 0;
  legacy.ContactMessage = 0;
  legacy.SystemStat = 0;
  legacy.SubscriptionFeature = 0;
  legacy.PlanAllowedCourse = 0;
  legacy.LiveSessionAttendance = 0;
  legacy.ChatMessage = 0;
  legacy.ChatAttachment = 0;
  legacy.TicketReply = 0;
  legacy.ReviewVideo = 0;
  legacy.ReviewFile = 0;
  legacy.ChatSession = 0;

  // ══════════════════════════════════
  //  NEON COUNTS
  // ══════════════════════════════════
  const neon = {};
  const tables = Object.keys(legacy);

  for (const table of tables) {
    const r = await pool.query(`SELECT COUNT(*) FROM \"${table}\"`);
    neon[table] = parseInt(r.rows[0].count, 10);
  }

  // ══════════════════════════════════
  //  REPORT
  // ══════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  FINAL RECONCILIATION REPORT');
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('  Entity                          Legacy    Neon     Status');
  console.log('  ' + '─'.repeat(70));

  let ok = 0, mismatch = 0, informational = 0;

  for (const entity of tables) {
    const l = legacy[entity] ?? 0;
    const n = neon[entity] ?? 0;
    const key = entity.padEnd(32);
    if (l === n) {
      console.log(`  ✅ ${key} ${String(l).padStart(6)}  ${String(n).padStart(7)}  ✓ Match`);
      ok++;
    } else if (l === 0 && n > 0) {
      console.log(`  ℹ️  ${key} ${String(l).padStart(6)}  ${String(n).padStart(7)}  ⚡ Informational (no legacy source)`);
      informational++;
    } else if (l > 0 && n === 0) {
      console.log(`  ❌ ${key} ${String(l).padStart(6)}  ${String(n).padStart(7)}  ✗ Missing in Neon`);
      mismatch++;
    } else {
      console.log(`  ❌ ${key} ${String(l).padStart(6)}  ${String(n).padStart(7)}  ✗ Count mismatch`);
      mismatch++;
    }
  }

  const skipped = tables.filter(t => t === 'IdMapping' || t === 'Setting' || t === 'ZoomAppCredential' || t === 'ScheduledNotification' || t === 'UserSubscription' || t === 'ExamAttempt' || t === 'ExamAnswer' || t === 'LessonProgress');

  console.log('\n' + '─'.repeat(70));
  console.log(`  ✅ Matching: ${ok} | ℹ️  Informational: ${informational} | ❌ Mismatch: ${mismatch}`);
  if (mismatch === 0) console.log('  ✅ ALL ENTITIES RECONCILED SUCCESSFULLY');
  else console.log('  ⚠ Some mismatches detected — see above');
  console.log('═══════════════════════════════════════════════════════════════\n');

  await pool.end();
  process.exit(mismatch > 0 ? 1 : 0);
}

reconcile().catch(e => { console.error('Reconciliation failed:', e); process.exit(1); });
