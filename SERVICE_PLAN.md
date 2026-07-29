# SERVICE PLAN — V2 Architecture

## Service Layer Design

Services contain ALL business logic. They orchestrate repository calls, enforce validation rules, manage transactions, and handle cross-entity operations.

## Service Directory Structure

```
src/
  services/
    _base.js                — Base service with common patterns
    user.service.js
    auth.service.js
    course.service.js
    lesson.service.js
    enrollment.service.js
    subscription.service.js
    quiz.service.js
    payment.service.js
    notification.service.js
    liveSession.service.js
    analytics.service.js
    review.service.js
    support.service.js
    chargeCode.service.js
    referral.service.js
    migration.service.js    — Migration orchestration
    validation.service.js   — Data integrity validation
    index.js                — Exports all services
```

## Service Layer Rules

1. Services NEVER import routes or controllers
2. Services NEVER handle HTTP requests/responses
3. Services ALWAYS return data objects (never throw HTTP errors)
4. Services throw typed AppErrors (caught by controllers)
5. Services handle unit-of-work patterns (transactions)
6. Services validate business rules before calling repositories
7. Services orchestrate multiple repository calls

## Base Service

```javascript
class BaseService {
  constructor(repository) {
    this.repo = repository;
  }

  async get(id) {
    const doc = await this.repo.get(id);
    if (!doc) throw new NotFoundError('Document not found');
    if (doc.deleted) throw new NotFoundError('Document has been deleted');
    return doc;
  }

  async create(data, userId) {
    return this.repo.create({
      ...data,
      createdBy: userId,
      updatedBy: userId
    });
  }

  async update(id, data, userId) {
    const existing = await this.get(id);
    return this.repo.update(id, {
      ...data,
      updatedBy: userId
    });
  }

  async delete(id, userId) {
    const existing = await this.get(id);
    return this.repo.softDelete(id, userId);
  }

  async list(filters = {}, options = {}) {
    const defaults = { deleted: false };
    return this.repo.query({ ...defaults, ...filters }, options);
  }
}
```

## Service Examples

### CourseService

```javascript
class CourseService extends BaseService {
  constructor() {
    super(new CourseRepository());
    this.unitRepo = new UnitRepository();
    this.lessonRepo = new LessonRepository();
    this.quizService = new QuizService();
  }

  async createFullCourse(data, userId) {
    // 1. Create course document
    const course = await this.create(data, userId);

    // 2. Create units (if provided)
    const units = [];
    if (data.units) {
      for (const unitData of data.units) {
        const unit = await this.unitRepo.create({
          ...unitData,
          courseId: course.id,
          createdBy: userId,
          updatedBy: userId
        });
        units.push(unit);
      }
    }

    return { course, units };
  }

  async getCourseWithLessons(courseId) {
    const course = await this.get(courseId);
    const units = await this.unitRepo.query({ courseId, deleted: false });
    const lessons = await this.lessonRepo.query({ courseId, deleted: false });
    return { course, units, lessons };
  }

  async getStudentCourses(studentId, stage, grade) {
    const courses = await this.repo.findActive({ orderBy: 'order' });
    // Filter by stage/grade
    return courses.filter(c => 
      (c.stage === stage || c.stage === 'all') &&
      (c.grade === grade || !c.grade)
    );
  }
}
```

### EnrollmentService

```javascript
class EnrollmentService {
  constructor() {
    this.enrollmentRepo = new EnrollmentRepository();
    this.paymentRepo = new PaymentRepository();
    this.courseRepo = new CourseRepository();
    this.userRepo = new UserRepository();
  }

  async enrollStudent(userId, courseId, paymentData) {
    // 1. Validate user exists and is active
    const user = await this.userRepo.get(userId);
    if (!user) throw new NotFoundError('User not found');

    // 2. Validate course exists
    const course = await this.courseRepo.get(courseId);
    if (!course) throw new NotFoundError('Course not found');

    // 3. Check for existing enrollment
    const existing = await this.enrollmentRepo.query({
      userId, courseId, status: 'active', deleted: false
    });
    if (existing.length > 0) {
      throw new ConflictError('Student already enrolled in this course');
    }

    // 4. Create enrollment + payment in transaction
    return db.runTransaction(async (tx) => {
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

      const enrollmentRef = db.collection('enrollments').doc();
      const paymentRef = db.collection('payments').doc();

      tx.set(enrollmentRef, enrollment);
      tx.set(paymentRef, payment);

      return {
        enrollmentId: enrollmentRef.id,
        paymentId: paymentRef.id
      };
    });
  }
}
```

### QuizService

```javascript
class QuizService {
  constructor() {
    this.quizRepo = new QuizRepository();
    this.questionRepo = new QuestionRepository();
    this.attemptRepo = new ExamAttemptRepository();
  }

  async createQuizWithQuestions(data, userId) {
    const { questions, ...quizData } = data;

    const quiz = await this.quizRepo.create({
      ...quizData,
      createdBy: userId,
      updatedBy: userId
    });

    const questionDocs = questions.map((q, i) => ({
      ...q,
      quizId: quiz.id,
      order: i,
      createdBy: userId
    }));

    const createdQuestions = await this.questionRepo.batchCreate(questionDocs);

    await this.quizRepo.update(quiz.id, {
      questionIds: createdQuestions.map(q => q.id),
      updatedBy: userId
    });

    return { quiz, questions: createdQuestions };
  }

  async gradeAttempt(userId, quizId, answers) {
    const quiz = await this.quizRepo.get(quizId);
    const questions = await this.questionRepo.query({
      quizId, status: 'active', deleted: false
    });

    let correct = 0;
    const gradedAnswers = answers.map((answer, i) => {
      const q = questions[i];
      const isCorrect = answer === q.correct;
      if (isCorrect) correct++;
      return { questionId: q.id, selected: answer, correct: isCorrect };
    });

    const total = questions.length;
    const percentage = Math.round((correct / total) * 100);

    const attempt = await this.attemptRepo.create({
      userId,
      quizId,
      courseId: quiz.courseId,
      answers: gradedAnswers,
      score: correct,
      total,
      correct,
      wrong: total - correct,
      percentage,
      passed: percentage >= (quiz.passPercentage || 60),
      attemptNumber: await this.getAttemptNumber(userId, quizId),
      completedAt: new Date().toISOString(),
      createdBy: userId
    });

    return attempt;
  }

  async getAttemptNumber(userId, quizId) {
    const attempts = await this.attemptRepo.query({
      userId, quizId
    }, { limit: 1, orderBy: 'attemptNumber', order: 'desc' });
    return attempts.length > 0 ? attempts[0].attemptNumber + 1 : 1;
  }
}
```

### NotificationService

```javascript
class NotificationService {
  constructor() {
    this.notifRepo = new NotificationRepository();
    this.userRepo = new UserRepository();
  }

  async sendToTarget(title, body, target, targetValue, url) {
    const notification = await this.notifRepo.create({
      title, body, target, targetValue, url,
      sentAt: new Date().toISOString()
    });

    // Determine recipients
    const recipients = await this.getRecipients(target, targetValue);

    // Send FCM (async, non-blocking)
    this.sendFCMBatch(recipients, title, body, url).catch(console.error);

    return { notification, recipientCount: recipients.length };
  }

  async getRecipients(target, targetValue) {
    const users = await this.userRepo.query({ deleted: false, status: 'active' });

    switch (target) {
      case 'all': return users;
      case 'admin': return users.filter(u => u.role === 'admin');
      case 'student': return users.filter(u => u.role === 'student');
      case 'grade': return users.filter(u => u.grade === targetValue);
      case 'stage': return users.filter(u => u.stage === targetValue);
      default: return [];
    }
  }

  async sendFCMBatch(users, title, body, url) {
    for (const user of users) {
      if (!user.fcmToken) continue;
      try {
        await admin.messaging().send({
          token: user.fcmToken,
          notification: { title, body },
          data: { url }
        });
      } catch (err) {
        if (err.code === 'messaging/invalid-registration-token') {
          await this.userRepo.update(user.id, { fcmToken: '' });
        }
      }
    }
  }
}
```

## Service Dependency Rules

```
Services can depend on:
  → Repositories  ✓
  → Other services ✓ (via dependency injection)
  → Models/validators ✓
  → Utility libraries ✓

Services MUST NOT depend on:
  → HTTP request/response  ✗
  → Express middleware  ✗
  → Session/cookie data  ✗
  → View templates  ✗
```

## Error Handling

```javascript
// Services throw typed errors:
class AppError extends Error {
  constructor(message, code = 'INTERNAL_ERROR', status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 'NOT_FOUND', 404);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 'CONFLICT', 409);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 'UNAUTHORIZED', 401);
  }
}
```
