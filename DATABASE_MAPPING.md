# DATABASE MAPPING — Legacy Schema to V2

## Legacy → V2 Collection Mapping

### 1. `users` (Legacy Array → V2 Collection)

**Legacy Structure:** Array of user objects embedded in `users` document.
**V2 Target:** `users/` collection with one document per user.

| Legacy Field | V2 Field | Notes |
|---|---|---|
| `id` / `uid` | `id` | Mapped to document ID |
| `name` | `name` | |
| `email` | `email` | |
| `phone` | `phone` | |
| `parentPhone` | `parentPhone` | |
| `governorate` | `governorate` | |
| `avatar` | `avatar` | URL string |
| `stage` | `stage` | |
| `grade` | `grade` | |
| `subscribedStage` | `subscribedStage` | |
| `role` | `role` | |
| `emailVerified` | `emailVerified` | |
| `phoneVerified` | `phoneVerified` | |
| `fcmToken` | `fcmToken` | |
| `subscriptionStatus` | `subscriptionStatus` | |
| `subscriptionStart` | `subscriptionStart` | |
| `subscriptionEnd` | `subscriptionEnd` | |
| `planName` | `planName` | |
| `planPeriod` | `planPeriod` | |
| `referralCode` | `referralCode` | |
| `referredBy` | `referredBy` | |
| `referralDiscount` | `referralDiscount` | |
| `referrals[]` | `referrals[]` | Array removed → `studentReferrals` collection |
| `parentName` | `parentName` | |
| `parentEmail` | `parentEmail` | |
| `parentId` | `parentId` | |
| `childrenIds[]` | `childrenIds[]` | |
| `progress` | ❌ | Splits to `studentProgress` + `studentLessonProgress` |
| `examResults[]` | `studentExamAttempts/` | One document per attempt |
| `quizResults` | ❌ | Merged into `studentExamAttempts` |
| `createdAt` | `createdAt` | |
| `lastLogin` | `lastLogin` | |
| — | `status` | NEW: `'active'` |
| — | `version` | NEW: `1` |
| — | `deleted` | NEW: `false` |
| — | `updatedAt` | NEW |

### 2. `courses` (Legacy Array → V2 Collection)

**Legacy Structure:** Array of course objects, each with embedded `lessons[]`, `sections[]`, `quiz{}`.
**V2 Target:** Splits into 5 collections: `courses/`, `units/`, `lessons/`, `lessonVideos/`, `lessonFiles/`, `quizzes/`, `questions/`.

| Legacy Field | V2 Collection:Field | Notes |
|---|---|---|
| `course.id` | `courses/{id}.id` | Document ID |
| `course.title` | `courses/{id}.title` | |
| `course.subtitle` | `courses/{id}.subtitle` | |
| `course.description` | `courses/{id}.description` | |
| `course.icon` | `courses/{id}.icon` | |
| `course.color` | `courses/{id}.color` | |
| `course.gradient` | `courses/{id}.gradient` | |
| `course.image` | `courses/{id}.image` | |
| `course.stage` | `courses/{id}.stage` | |
| `course.grade` | `courses/{id}.grade` | |
| `course.semester` | `courses/{id}.semester` | |
| `course.price` | `courses/{id}.price` | |
| `course.guestVisible` | `courses/{id}.guestVisible` | |
| `course.active` | `courses/{id}.active` | |
| `course.order` | `courses/{id}.order` | |
| `course.sections[]` | `units/` collection | Each section → unit document |
| `course.sections[].lessons[]` | `units/{id}.lessonIds[]` | Reference array |
| `course.lessons[]` | `lessons/` collection | Each lesson → document |
| `course.lessons[].videos[]` | `lessonVideos/` collection | Each video → document |
| `course.lessons[].pdfFiles[]` | `lessonFiles/` collection | Each file → document |
| `course.quiz` | `quizzes/` collection | Course-level quiz |
| `course.quiz.questions[]` | `questions/` collection | Each question → document |

### 3. Course → Unit Mapping (Embedded Section → Flat Collection)

```
Legacy course.sections[i]:
  { id, name, lessons: [lessonId, ...] }

V2 units/{id}:
  id: string
  courseId: string (reference)
  name: string
  order: number
  lessonIds: string[] (references)
  status: 'active'
  version: 1
  deleted: false
  createdAt: Timestamp
  updatedAt: Timestamp
```

### 4. Course → Lesson Mapping (Embedded → Flat)

```
Legacy course.lessons[i]:
  { id, title, description, duration, order, isFree, guestVisible, sectionId,
    videos: [{title, url}], pdfFiles: [{title, url}], quiz: {...}|null }

V2 lessons/{id}:
  id: string
  courseId: string (reference)
  unitId: string | null (reference to unit)
  title: string
  description: string
  duration: string
  order: number
  isFree: boolean
  guestVisible: boolean
  videoIds: string[] (references to lessonVideos/)
  fileIds: string[] (references to lessonFiles/)
  quizId: string | null (reference)
  status: 'active'
  version: 1
  deleted: false
  createdAt: Timestamp
  updatedAt: Timestamp
```

### 5. Lesson Video Mapping

```
V2 lessonVideos/{id}:
  id: string
  lessonId: string (reference)
  title: string
  url: string
  order: number
  status: 'active'
  createdAt: Timestamp
```

### 6. Lesson File Mapping

```
V2 lessonFiles/{id}:
  id: string
  lessonId: string (reference)
  title: string
  url: string
  type: string ('pdf' | 'doc' | etc.)
  order: number
  status: 'active'
  createdAt: Timestamp
```

### 7. Quiz → Question Mapping (Embedded → Flat)

```
Legacy course.quiz or lesson.quiz or review.quiz:
  { id, title, questions: [{question, options, correct, type}], timerMinutes }

V2 quizzes/{id}:
  id: string
  title: string
  timerMinutes: number | null
  passPercentage: number (for lesson quizzes)
  entityType: 'course' | 'lesson' | 'review'
  entityId: string (reference to course/lesson/review)
  questionIds: string[] (references)
  status: 'active'
  version: 1
  deleted: false
  createdAt: Timestamp
  updatedAt: Timestamp

V2 questions/{id}:
  id: string
  quizId: string (reference)
  question: string
  options: string[4]
  correct: number (0-based index)
  type: string | null ('true-false')
  order: number
  status: 'active'
  createdAt: Timestamp
```

### 8. User Progress → Student Progress

```
Legacy user.progress:
  { courseId: { completedLessons, percentage, watchTime, updatedAt, positions, lessons } }

V2 studentProgress/{autoId}:
  id: string
  userId: string (reference)
  courseId: string (reference)
  completedLessons: string[] (lesson ID references)
  percentage: number
  watchTime: number (total seconds)
  updatedAt: Timestamp
  createdAt: Timestamp

V2 studentLessonProgress/{autoId}:
  id: string
  userId: string (reference)
  courseId: string (reference)
  lessonId: string (reference)
  watchTime: number (seconds)
  resumePosition: number (seconds)
  status: 'not_started' | 'watching' | 'completed'
  completedAt: Timestamp | null
  createdAt: Timestamp
  updatedAt: Timestamp
```

### 9. User Exam Results → Student Exam Attempts

```
Legacy user.examResults[]:
  { examId, courseId, examName, score, total, correct, wrong, timeTaken, percentage, date, completedAt }

Legacy user.quizResults:
  { courseId: { lessonId: { answers, score, total, percentage, passed, completedAt } } }

V2 studentExamAttempts/{autoId}:
  id: string
  userId: string (reference)
  quizId: string (reference)
  courseId: string (reference)
  lessonId: string | null
  examName: string
  answers: number[] (selected option indices)
  score: number (raw score)
  total: number (max possible)
  correct: number
  wrong: number
  timeTaken: number (seconds)
  percentage: number (0-100)
  passed: boolean
  attemptNumber: number
  completedAt: Timestamp
  createdAt: Timestamp
```

### 10. Live Sessions

```
Legacy liveSessions[] array → V2 liveSessions/ collection (each session = 1 document)

Legacy liveSessionAttendance/<sessionId>/<userId> → V2 liveSessionAttendance/ same
(RTDB, stays as-is)
```

### 11. Settings

```
Legacy settings: { currentSemester, vodafoneCash, instaPay, ... }
V2 settings/{key}: One document per setting key
  id: 'general'
  currentSemester: string
  vodafoneCash: string
  instaPay: string
  contactPhone: string
  contactEmail: string
  contactAddress: string
  contactWhatsapp: string
  referralDiscount: number
  announcementsEnabled: boolean
  status: 'active'
  version: 1
  updatedAt: Timestamp
  updatedBy: string
```

### 12. Notifications

```
Legacy notifications[] array → V2 notifications/ collection
  Each notification = 1 document
  Add: status, version, deleted, createdAt, updatedAt

Legacy dismissed/<userId> → V2 notificationDismissals/ collection
  { userId, notificationId, dismissedAt }
```

### Collections That Stay (Already Flat)

| Collection | V2 Action |
|---|---|
| `subscriptions/` | Add document standard fields |
| `supportTickets/` | Add document standard fields, replies as subcollection |
| `reviews/` | Split embedded videos/files/questions |
| `notes/` | Add document standard fields |
| `announcements/` | Add document standard fields |
| `questionBanks/` | Migrate embedded questions to questions/ collection |
| `parentInvites/` | Add document standard fields |
| `chargeCodes/` | Move from RTDB to Firestore |
| `contacts/` | Add document standard fields |
| `themeConfig/` | Keep single document |
| `appConfig/` | Keep single document |
| `maintenanceMode/` | Keep single document |
| `quotes/` | Add document standard fields |
| `payments/` | Add document standard fields |

## RTDB → Firestore Migration Candidates

| RTDB Path | V2 Target | Priority |
|---|---|---|
| `chargeCodes/` | `chargeCodes/` collection | High |
| `settings/` | `settings/` collection | Done |
| `zoomAppCredentials/` | Firestore as single doc | Medium |
| `zoomCredentials/<uid>` | Firestore as encrypted blob | Low |

## RTDB Collections That STAY in RTDB

| Path | Reason |
|---|---|
| `chatMessages/<chatId>/<messageId>` | Real-time delivery required |
| `liveSessionAttendance/<sessionId>/<userId>` | Real-time attendance tracking |
| `liveSessionState/<sessionId>` | Temporary, non-persistent |
| `presence/<userId>` | Ephemeral presence data |
