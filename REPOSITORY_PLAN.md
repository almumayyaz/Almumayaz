# REPOSITORY PLAN — V2 Architecture

## Repository Layer Design

The repository layer is the ONLY layer that communicates with Firestore. Each major entity gets its own repository file.

## Base Repository

```
src/repositories/_base.js
```

Provides:
- `get(id)` — Get document by ID
- `create(data)` — Create document with standard fields
- `update(id, data)` — Partial update
- `softDelete(id)` — Set `deleted: true`
- `hardDelete(id)` — Actually delete (admin only, logged)
- `query(filters, options)` — Query with pagination
- `list(filters, options)` — List with cursor pagination
- `batchCreate(items)` — Batched write
- `batchUpdate(items)` — Batched update
- `transaction(operation)` — Transaction wrapper

### Base Repository Methods

```javascript
class BaseRepository {
  constructor(collectionName) {
    this.collection = db.collection(collectionName);
  }

  async get(id) {
    const doc = await this.collection.doc(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }

  async create(data) {
    const id = data.id || generateId(this.collectionName);
    const now = FieldValue.serverTimestamp();
    const doc = {
      id,
      ...data,
      createdAt: now,
      updatedAt: now,
      createdBy: data.createdBy || null,
      updatedBy: data.updatedBy || null,
      status: 'active',
      version: 1,
      deleted: false,
      deletedAt: null,
      deletedBy: null
    };
    await this.collection.doc(id).set(doc);
    return { ...doc, createdAt: new Date(), updatedAt: new Date() };
  }

  async update(id, data) {
    const updates = {
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
      version: FieldValue.increment(1)
    };
    await this.collection.doc(id).update(updates);
    return this.get(id);
  }

  async softDelete(id, userId) {
    return this.update(id, {
      deleted: true,
      deletedAt: FieldValue.serverTimestamp(),
      deletedBy: userId,
      status: 'archived'
    });
  }

  async query(filters = {}, options = {}) {
    let query = this.collection;
    for (const [field, value] of Object.entries(filters)) {
      query = query.where(field, '==', value);
    }
    if (options.limit) query = query.limit(options.limit);
    if (options.orderBy) query = query.orderBy(options.orderBy, options.order || 'asc');
    if (options.startAfter) query = query.startAfter(options.startAfter);
    const snap = await query.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async batchCreate(items) {
    const batch = db.batch();
    const results = [];
    for (const item of items) {
      const id = item.id || generateId(this.collectionName);
      const now = FieldValue.serverTimestamp();
      const doc = {
        id,
        ...item,
        createdAt: now,
        updatedAt: now,
        status: 'active',
        version: 1,
        deleted: false
      };
      batch.set(this.collection.doc(id), doc);
      results.push(doc);
    }
    await batch.commit();
    return results;
  }

  async transaction(operation) {
    return db.runTransaction(operation);
  }
}
```

## Repository List

| Repository | Collection | Extends Base | Notes |
|---|---|---|---|
| `UserRepository` | `users` | Yes | Auth integration, email lookup |
| `GradeRepository` | `grades` | Yes | |
| `SubjectRepository` | `subjects` | Yes | |
| `CourseRepository` | `courses` | Yes | |
| `UnitRepository` | `units` | Yes | Query by courseId |
| `LessonRepository` | `lessons` | Yes | Query by courseId, unitId |
| `VideoRepository` | `lessonVideos` | Yes | Query by lessonId |
| `FileRepository` | `lessonFiles` | Yes | Query by lessonId |
| `QuizRepository` | `quizzes` | Yes | |
| `QuestionRepository` | `questions` | Yes | Query by quizId |
| `QuestionBankRepository` | `questionBanks` | Yes | |
| `SubscriptionRepository` | `subscriptions` | Yes | |
| `EnrollmentRepository` | `enrollments` | Yes | Query by userId, courseId |
| `PaymentRepository` | `payments` | Yes | |
| `ReceiptRepository` | `paymentReceipts` | Yes | |
| `ProgressRepository` | `studentProgress` | Yes | Query by userId, courseId |
| `LessonProgressRepository` | `studentLessonProgress` | Yes | Query by userId, lessonId |
| `ExamAttemptRepository` | `studentExamAttempts` | Yes | Query by userId, quizId |
| `BookmarkRepository` | `studentBookmarks` | Yes | Query by userId |
| `NoteRepository` | `studentNotes` | Yes | Query by userId, lessonId |
| `NotificationRepository` | `notifications` | Yes | Query by target, sentAt |
| `ReviewRepository` | `reviews` | Yes | |
| `AnnouncementRepository` | `announcements` | Yes | |
| `TicketRepository` | `supportTickets` | Yes | Subcollection for replies |
| `SettingRepository` | `settings` | Yes | Single document key-value |
| `FlagRepository` | `featureFlags` | Yes | |
| `ActivityLogRepository` | `activityLogs` | Yes | Write-only, append-only |
| `InviteRepository` | `parentInvites` | Yes | |
| `ChargeCodeRepository` | `chargeCodes` | Yes | |
| `AnalyticsRepository` | `analytics` | Yes | Read-only agg queries |
| `SystemStatsRepository` | `systemStats` | Yes | Write-only, periodic |

## Repository Directory Structure

```
src/
  repositories/
    _base.js
    user.repository.js
    grade.repository.js
    subject.repository.js
    course.repository.js
    unit.repository.js
    lesson.repository.js
    video.repository.js
    file.repository.js
    quiz.repository.js
    question.repository.js
    questionBank.repository.js
    subscription.repository.js
    enrollment.repository.js
    payment.repository.js
    receipt.repository.js
    progress.repository.js
    lessonProgress.repository.js
    examAttempt.repository.js
    bookmark.repository.js
    note.repository.js
    notification.repository.js
    review.repository.js
    announcement.repository.js
    ticket.repository.js
    setting.repository.js
    flag.repository.js
    activityLog.repository.js
    invite.repository.js
    chargeCode.repository.js
    analytics.repository.js
    systemStats.repository.js
    index.js  — exports all repositories
```

## Repository Example: CourseRepository

```javascript
const BaseRepository = require('./_base');

class CourseRepository extends BaseRepository {
  constructor() {
    super('courses');
  }

  async findByGrade(grade, options) {
    return this.query(
      { grade, deleted: false, status: 'active' },
      { orderBy: 'order', ...options }
    );
  }

  async findByStage(stage, options) {
    return this.query(
      { stage, deleted: false },
      { orderBy: 'order', ...options }
    );
  }

  async findActive(options) {
    return this.query(
      { deleted: false, status: 'active' },
      { orderBy: 'order', ...options }
    );
  }
}
```

## Transaction Examples

### Enrollment + Payment Transaction
```javascript
async function enrollWithPayment(userId, courseId, paymentData) {
  return db.runTransaction(async (transaction) => {
    const enrollmentRef = db.collection('enrollments').doc();
    const paymentRef = db.collection('payments').doc();
    
    const enrollment = {
      userId, courseId,
      enrolledAt: FieldValue.serverTimestamp(),
      status: 'active'
    };
    
    const payment = {
      ...paymentData,
      userId, courseId,
      createdAt: FieldValue.serverTimestamp()
    };
    
    transaction.set(enrollmentRef, enrollment);
    transaction.set(paymentRef, payment);
    
    return { enrollmentId: enrollmentRef.id, paymentId: paymentRef.id };
  });
}
```

## Repository Rules

1. Repositories NEVER contain business logic
2. Repositories ALWAYS return plain objects (not Firestore documents)
3. Repositories handle Firestore errors gracefully (log + rethrow as AppError)
4. Repositories NEVER import services or controllers
5. Repositories are stateless (no instance variables for caching)
6. All queries use indexes (no collection scans)
7. All list operations support cursor pagination
