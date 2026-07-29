# VALIDATION PLAN — Data Integrity Verification

## Validation Levels

### Level 1: Schema Validation
Verify each V2 document has all required fields.

### Level 2: Relationship Validation
Verify all document ID references resolve to existing documents.

### Level 3: Count Validation
Verify document counts match between legacy and V2.

### Level 4: Content Validation
Verify critical field values match between legacy and V2.

### Level 5: Application Validation
Verify all API endpoints work correctly with V2 data.

## Validation Scripts

### 1. Schema Validator

```javascript
// migrations/validators/schema-validator.js
const REQUIRED_FIELDS = {
  'courses': ['id', 'title', 'stage', 'grade', 'status', 'version', 'createdAt'],
  'units': ['id', 'courseId', 'name', 'order', 'status'],
  'lessons': ['id', 'courseId', 'title', 'order', 'status'],
  'lessonVideos': ['id', 'lessonId', 'title', 'url'],
  'lessonFiles': ['id', 'lessonId', 'title', 'url'],
  'quizzes': ['id', 'title', 'entityType', 'entityId', 'status'],
  'questions': ['id', 'quizId', 'question', 'options', 'correct'],
  'users': ['id', 'name', 'email', 'role', 'status'],
  'enrollments': ['id', 'userId', 'courseId', 'status'],
  'payments': ['id', 'userId', 'amount', 'method'],
  'studentProgress': ['id', 'userId', 'courseId'],
};

async function validateSchema(collectionName, docs) {
  const fields = REQUIRED_FIELDS[collectionName];
  if (!fields) return { valid: true, errors: [] };

  const errors = [];
  for (const doc of docs) {
    for (const field of fields) {
      if (doc[field] === undefined || doc[field] === null) {
        errors.push({
          id: doc.id,
          field,
          message: `Missing required field: ${field}`
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    totalChecked: docs.length,
    errorCount: errors.length
  };
}
```

### 2. Relationship Validator

```javascript
// migrations/validators/relationship-validator.js
async function validateRelationships() {
  const results = [];

  // Check unit → course references
  const units = await db.collection('units').get();
  for (const unit of units.docs) {
    const data = unit.data();
    const course = await db.collection('courses').doc(data.courseId).get();
    if (!course.exists) {
      results.push({
        type: 'orphan_unit',
        unitId: unit.id,
        courseId: data.courseId,
        message: 'Unit references non-existent course'
      });
    }
  }

  // Check lesson → course references
  const lessons = await db.collection('lessons').get();
  for (const lesson of lessons.docs) {
    const data = lesson.data();
    const course = await db.collection('courses').doc(data.courseId).get();
    if (!course.exists) {
      results.push({
        type: 'orphan_lesson',
        lessonId: lesson.id,
        courseId: data.courseId,
        message: 'Lesson references non-existent course'
      });
    }
    if (data.unitId) {
      const unit = await db.collection('units').doc(data.unitId).get();
      if (!unit.exists) {
        results.push({
          type: 'orphan_lesson_unit',
          lessonId: lesson.id,
          unitId: data.unitId,
          message: 'Lesson references non-existent unit'
        });
      }
    }
  }

  // Check question → quiz references
  const questions = await db.collection('questions').get();
  for (const q of questions.docs) {
    const data = q.data();
    const quiz = await db.collection('quizzes').doc(data.quizId).get();
    if (!quiz.exists) {
      results.push({
        type: 'orphan_question',
        questionId: q.id,
        quizId: data.quizId,
        message: 'Question references non-existent quiz'
      });
    }
  }

  // Check enrollment → user/course references
  const enrollments = await db.collection('enrollments').get();
  for (const e of enrollments.docs) {
    const data = e.data();
    const user = await db.collection('users').doc(data.userId).get();
    if (!user.exists) {
      results.push({
        type: 'orphan_enrollment_user',
        enrollmentId: e.id,
        userId: data.userId,
        message: 'Enrollment references non-existent user'
      });
    }
    const course = await db.collection('courses').doc(data.courseId).get();
    if (!course.exists) {
      results.push({
        type: 'orphan_enrollment_course',
        enrollmentId: e.id,
        courseId: data.courseId,
        message: 'Enrollment references non-existent course'
      });
    }
  }

  return results;
}
```

### 3. Count Validator

```javascript
// migrations/validators/count-validator.js
async function validateCounts(legacySource, v2Collection) {
  // Legacy count (from readData or direct Firebase read)
  const legacyCount = await getLegacyCount(legacySource);

  // V2 count
  const v2Snap = await db.collection(v2Collection).count().get();
  const v2Count = v2Snap.data().count;

  return {
    collection: v2Collection,
    legacyCount,
    v2Count,
    match: legacyCount === v2Count,
    difference: Math.abs(legacyCount - v2Count)
  };
}
```

### 4. Content Validator

```javascript
// migrations/validators/content-validator.js
async function validateContent(legacyCollection, v2Collection, idField, fieldsToCheck) {
  const mismatches = [];

  // Read legacy data
  const legacyData = await readData(legacyCollection);
  const legacyMap = {};
  for (const item of legacyData) {
    legacyMap[item.id] = item;
  }

  // Read V2 data
  const v2Snap = await db.collection(v2Collection).get();
  const v2Docs = v2Snap.docs.map(d => ({ id: d.id, ...d.data() }));

  for (const v2Doc of v2Docs) {
    const legacy = legacyMap[v2Doc[idField]];
    if (!legacy) {
      mismatches.push({
        id: v2Doc.id,
        field: idField,
        message: `V2 document has no legacy counterpart`
      });
      continue;
    }

    for (const field of fieldsToCheck) {
      if (JSON.stringify(v2Doc[field]) !== JSON.stringify(legacy[field])) {
        mismatches.push({
          id: v2Doc.id,
          field,
          legacy: legacy[field],
          v2: v2Doc[field],
          message: `Field mismatch: ${field}`
        });
      }
    }
  }

  return mismatches;
}
```

## Validation Runner

```javascript
// migrations/validate-migration.js
async function runFullValidation() {
  const results = {
    schema: [],
    relationships: [],
    counts: [],
    content: [],
    passed: true
  };

  // Schema validation
  for (const [collection, fields] of Object.entries(REQUIRED_FIELDS)) {
    const snap = await db.collection(collection).get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const result = await validateSchema(collection, docs);
    results.schema.push(result);
    if (!result.valid) results.passed = false;
  }

  // Relationship validation
  const relErrors = await validateRelationships();
  results.relationships = relErrors;
  if (relErrors.length > 0) results.passed = false;

  // Count validation
  const countResults = await validateAllCounts();
  results.counts = countResults;
  if (countResults.some(r => !r.match)) results.passed = false;

  // Report
  console.log(JSON.stringify(results, null, 2));
  return results;
}
```

## Critical Validation Checks

Before switching reads/writes, verify:
1. All course-lesson-video-file relationships are intact
2. All user progress references valid courses/lessons
3. All exam attempts reference valid quizzes
4. No orphaned documents exist
5. Document counts match between legacy and V2
6. Key fields (titles, grades, stages) match
7. Subscription/enrollment statuses are preserved
8. Payment records are complete

## Automated Validation Script

```bash
# Run after each migration phase
npm run validate:migration -- --phase=3

# Run full validation
npm run validate:full

# Check specific collection
npm run validate:collection -- --collection=lessons

# Compare legacy vs V2 counts
npm run validate:counts
```
