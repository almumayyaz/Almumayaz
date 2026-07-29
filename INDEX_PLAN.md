# INDEX PLAN — Firestore Composite Indexes

## Query Patterns & Required Indexes

### Users Collection
```javascript
// Query: Get user by role
db.collection('users').where('role', '==', 'student')
INDEX: role ASC, status ASC

// Query: Get user by grade + stage
db.collection('users').where('grade', '==', grade).where('stage', '==', stage)
INDEX: grade ASC, stage ASC

// Query: Active users by role (pagination)
db.collection('users').where('role', '==', 'student').where('status', '==', 'active').orderBy('createdAt')
INDEX: role ASC, status ASC, createdAt ASC
```

### Lessons Collection
```javascript
// Query: Lessons by course + order
db.collection('lessons').where('courseId', '==', courseId).orderBy('order')
INDEX: courseId ASC, order ASC

// Query: Lessons by course + unit
db.collection('lessons').where('courseId', '==', courseId).where('unitId', '==', unitId).orderBy('order')
INDEX: courseId ASC, unitId ASC, order ASC

// Query: Active lessons by course
db.collection('lessons').where('courseId', '==', courseId).where('deleted', '==', false)
INDEX: courseId ASC, deleted ASC
```

### Units Collection
```javascript
// Query: Units by course + order
db.collection('units').where('courseId', '==', courseId).orderBy('order')
INDEX: courseId ASC, order ASC
```

### Lesson Videos
```javascript
// Query: Videos by lesson + order
db.collection('lessonVideos').where('lessonId', '==', lessonId).orderBy('order')
INDEX: lessonId ASC, order ASC
```

### Lesson Files
```javascript
// Query: Files by lesson
db.collection('lessonFiles').where('lessonId', '==', lessonId)
INDEX: lessonId ASC
```

### Questions
```javascript
// Query: Questions by quiz + order
db.collection('questions').where('quizId', '==', quizId).orderBy('order')
INDEX: quizId ASC, order ASC
```

### Enrollments
```javascript
// Query: Enrollments by user
db.collection('enrollments').where('userId', '==', userId).where('status', '==', 'active')
INDEX: userId ASC, status ASC

// Query: Enrollments by course
db.collection('enrollments').where('courseId', '==', courseId).where('status', '==', 'active')
INDEX: courseId ASC, status ASC
```

### Student Progress
```javascript
// Query: Progress by user
db.collection('studentProgress').where('userId', '==', userId)
INDEX: userId ASC

// Query: Progress by user + course
db.collection('studentProgress').where('userId', '==', userId).where('courseId', '==', courseId)
INDEX: userId ASC, courseId ASC
```

### Student Lesson Progress
```javascript
// Query: Lesson progress by user + course
db.collection('studentLessonProgress').where('userId', '==', userId).where('courseId', '==', courseId)
INDEX: userId ASC, courseId ASC

// Query: Lesson progress by user + lesson
db.collection('studentLessonProgress').where('userId', '==', userId).where('lessonId', '==', lessonId)
INDEX: userId ASC, lessonId ASC
```

### Student Exam Attempts
```javascript
// Query: Attempts by user + quiz
db.collection('studentExamAttempts').where('userId', '==', userId).where('quizId', '==', quizId).orderBy('attemptNumber', 'desc')
INDEX: userId ASC, quizId ASC, attemptNumber DESC

// Query: Attempts by user (recent first)
db.collection('studentExamAttempts').where('userId', '==', userId).orderBy('completedAt', 'desc')
INDEX: userId ASC, completedAt DESC
```

### Notifications
```javascript
// Query: Notifications by target + sentAt
db.collection('notifications').where('target', '==', 'all').orderBy('sentAt', 'desc')
INDEX: target ASC, sentAt DESC

// Query: Notifications by target + targetValue
db.collection('notifications').where('target', '==', 'grade').where('targetValue', '==', grade)
INDEX: target ASC, targetValue ASC
```

### Support Tickets
```javascript
// Query: Tickets by user
db.collection('supportTickets').where('userId', '==', userId).orderBy('createdAt', 'desc')
INDEX: userId ASC, createdAt DESC

// Query: Tickets by status
db.collection('supportTickets').where('status', '==', 'open').orderBy('createdAt', 'desc')
INDEX: status ASC, createdAt DESC
```

### Charge Codes
```javascript
// Query: Code by code string
db.collection('chargeCodes').where('code', '==', code)
INDEX: code ASC
```

## Index Creation Script

```javascript
// scripts/create-indexes.js
const { Firestore } = require('@google-cloud/firestore');

async function createIndexes() {
  const firestore = new Firestore();
  const indexes = [
    // Users
    { collection: 'users', fields: [{ fieldPath: 'role', order: 'ASCENDING' }, { fieldPath: 'status', order: 'ASCENDING' }] },
    { collection: 'users', fields: [{ fieldPath: 'grade', order: 'ASCENDING' }, { fieldPath: 'stage', order: 'ASCENDING' }] },
    { collection: 'users', fields: [{ fieldPath: 'role', order: 'ASCENDING' }, { fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'createdAt', order: 'ASCENDING' }] },

    // Lessons
    { collection: 'lessons', fields: [{ fieldPath: 'courseId', order: 'ASCENDING' }, { fieldPath: 'order', order: 'ASCENDING' }] },
    { collection: 'lessons', fields: [{ fieldPath: 'courseId', order: 'ASCENDING' }, { fieldPath: 'unitId', order: 'ASCENDING' }, { fieldPath: 'order', order: 'ASCENDING' }] },
    { collection: 'lessons', fields: [{ fieldPath: 'courseId', order: 'ASCENDING' }, { fieldPath: 'deleted', order: 'ASCENDING' }] },

    // Units
    { collection: 'units', fields: [{ fieldPath: 'courseId', order: 'ASCENDING' }, { fieldPath: 'order', order: 'ASCENDING' }] },

    // Enrollments
    { collection: 'enrollments', fields: [{ fieldPath: 'userId', order: 'ASCENDING' }, { fieldPath: 'status', order: 'ASCENDING' }] },
    { collection: 'enrollments', fields: [{ fieldPath: 'courseId', order: 'ASCENDING' }, { fieldPath: 'status', order: 'ASCENDING' }] },

    // Progress
    { collection: 'studentProgress', fields: [{ fieldPath: 'userId', order: 'ASCENDING' }] },
    { collection: 'studentProgress', fields: [{ fieldPath: 'userId', order: 'ASCENDING' }, { fieldPath: 'courseId', order: 'ASCENDING' }] },

    // Quizzes
    { collection: 'questions', fields: [{ fieldPath: 'quizId', order: 'ASCENDING' }, { fieldPath: 'order', order: 'ASCENDING' }] },

    // Exam attempts
    { collection: 'studentExamAttempts', fields: [{ fieldPath: 'userId', order: 'ASCENDING' }, { fieldPath: 'quizId', order: 'ASCENDING' }, { fieldPath: 'attemptNumber', order: 'DESCENDING' }] },

    // Notifications
    { collection: 'notifications', fields: [{ fieldPath: 'target', order: 'ASCENDING' }, { fieldPath: 'sentAt', order: 'DESCENDING' }] },
    { collection: 'notifications', fields: [{ fieldPath: 'target', order: 'ASCENDING' }, { fieldPath: 'targetValue', order: 'ASCENDING' }] },

    // Tickets
    { collection: 'supportTickets', fields: [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'createdAt', order: 'DESCENDING' }] },
  ];

  for (const idx of indexes) {
    try {
      await firestore.collection(idx.collection).createIndex({
        fields: idx.fields,
        queryScope: 'COLLECTION'
      });
      console.log(`Created index: ${idx.collection}`);
    } catch (e) {
      console.error(`Failed index ${idx.collection}:`, e.message);
    }
  }
}

createIndexes();
```

## Query Optimization Rules

1. Always use `where()` before `orderBy()`
2. Always include `limit()` for list endpoints
3. Use `select()` for projection when only specific fields needed
4. Use `startAfter()` for cursor pagination (never offset)
5. Avoid `array-contains` on large arrays
6. Ensure all query patterns have corresponding composite indexes
7. Monitor slow queries in Firebase Console
