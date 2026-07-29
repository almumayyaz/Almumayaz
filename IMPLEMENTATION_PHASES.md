# IMPLEMENTATION PHASES — Execution Order

## Phase Overview

| Phase | Name | Duration | Risk | Rollback |
|---|---|---|---|---|
| 1 | Foundations + Repository Layer | High effort | Low | Easy |
| 2 | Settings + Small Config Migration | Low effort | Low | Easy |
| 3 | Course Content Migration | High effort | Medium | Medium |
| 4 | User + Progress Migration | High effort | High | Complex |
| 5 | Activity Data Migration | Medium effort | Medium | Medium |
| 6 | Service Layer Implementation | High effort | Medium | Easy |
| 7 | Route/Controller Refactoring | High effort | High | Complex |
| 8 | Read Switch | Low effort | High | Critical |
| 9 | Write Switch | Low effort | High | Critical |
| 10 | Archive + Cleanup | Low effort | Low | Easy |

---

## PHASE 1: Foundations + Repository Layer

**Objective:** Create the base infrastructure without affecting production.

**Files Modified:**
```
NEW: src/repositories/_base.js
NEW: src/repositories/index.js
NEW: src/repositories/user.repository.js
NEW: src/repositories/course.repository.js
NEW: src/repositories/unit.repository.js
NEW: src/repositories/lesson.repository.js
NEW: src/repositories/video.repository.js
NEW: src/repositories/file.repository.js
NEW: src/repositories/quiz.repository.js
NEW: src/repositories/question.repository.js
NEW: src/repositories/enrollment.repository.js
NEW: src/repositories/progress.repository.js
NEW: src/repositories/lessonProgress.repository.js
NEW: src/repositories/examAttempt.repository.js
NEW: src/repositories/notification.repository.js
NEW: src/repositories/setting.repository.js
NEW: src/repositories/payment.repository.js
NEW: src/repositories/ticket.repository.js
NEW: src/repositories/review.repository.js
NEW: src/repositories/announcement.repository.js
NEW: src/repositories/chargeCode.repository.js
NEW: src/repositories/invite.repository.js
NEW: src/repositories/analytics.repository.js
NEW: src/services/_base.js
NEW: src/services/index.js
```

**Database Impact:** NONE — No data written to V2 collections yet.

**API Impact:** NONE — Existing `readData`/`writeData` continue to work unchanged.

**Rollback Strategy:** Delete `src/repositories/` and `src/services/` directories.

**Validation:** Test repositories against Firestore emulator.

---

## PHASE 2: Settings + Small Config Migration

**Objective:** Migrate settings, themeConfig, appConfig, maintenanceMode to V2 format.

**Files Modified:**
```
NEW: migrations/migrate-settings.js
NEW: src/services/setting.service.js
MODIFY: app.js (add V2 setting read with legacy fallback)
```

**Database Impact:** Creates `settings/general` document in Firestore.

**API Impact:** NONE — Adding dual-read support, not switching yet.

**Rollback Strategy:** Delete `settings/general` document.

**Validation:**
```
Read legacy settings → compare values with V2
Verify dual-read returns correct values
```

---

## PHASE 3: Course Content Migration

**Objective:** Split embedded course data into separate V2 collections.

**Files Modified:**
```
NEW: migrations/legacy-course-reader.js
NEW: migrations/migrate-courses.js
NEW: migrations/transformers/course-transformer.js
NEW: migrations/transformers/lesson-transformer.js
NEW: migrations/transformers/quiz-transformer.js
NEW: migrations/validators/course-validator.js
```

**Database Impact:** Creates documents in: `courses/`, `units/`, `lessons/`, `lessonVideos/`, `lessonFiles/`, `quizzes/`, `questions/`.

**API Impact:** NONE — All routes still read from legacy nested structure.

**Migration Script:**
```
for each course in legacy courses[]:
  1. Create course document in courses/
  2. For each section → create unit document in units/
  3. For each lesson → create lesson document in lessons/
     → For each video → create video document in lessonVideos/
     → For each PDF → create file document in lessonFiles/
  4. For each quiz → create quiz document in quizzes/
     → For each question → create question document in questions/
  5. Update course document with unitIds, lessonIds, quizIds
```

**Rollback Strategy:** Delete all documents created in V2 collections.

**Validation:**
```
- Legacy course count === V2 course count
- Legacy lesson count === V2 lesson count
- Legacy video count === V2 video count
- All lesson.courseId references valid course
- All video.lessonId references valid lesson
```

---

## PHASE 4: User + Progress Migration

**Objective:** Split embedded user progress, exam results, bookmarks into separate collections.

**Files Modified:**
```
NEW: migrations/migrate-users.js
NEW: migrations/migrate-progress.js
NEW: migrations/migrate-exam-results.js
```

**Database Impact:** Creates documents in: `studentProgress/`, `studentLessonProgress/`, `studentExamAttempts/`.

**API Impact:** NONE — Routes still read from `user.progress`, `user.examResults`.

**Migration Script:**
```
for each user in legacy users[]:
  1. Create user document in users/ (ensure all fields)
  2. For each course in user.progress:
     → Create studentProgress document
     → For each lesson in progress.lessons:
       → Create studentLessonProgress document
  3. For each entry in user.examResults:
     → Create studentExamAttempt document
```

**Rollback Strategy:** Delete all V2 progress/attempt documents.

**Validation:**
```
- Legacy user count === V2 user count
- All studentProgress.userId references valid user
- All studentProgress references valid course
- All studentExamAttempts.userId references valid user
```

---

## PHASE 5: Activity Data Migration

**Objective:** Move remaining activity collections to V2 format.

**Files Modified:**
```
NEW: migrations/migrate-notifications.js
NEW: migrations/migrate-announcements.js
NEW: migrations/migrate-charge-codes.js
```

**Database Impact:** Creates/updates documents in notifications/, announcements/, chargeCodes/.

**API Impact:** NONE.

**Migration Script:**
```
1. Migrate notifications from legacy array to V2 collection
2. Migrate announcements from legacy array to V2 collection  
3. Migrate chargeCodes from RTDB to Firestore collection
```

**Rollback Strategy:** Delete migrated V2 documents.

**Validation:**
```
- Counts match between legacy and V2
- No data loss on key fields
- RTDB charge codes still intact
```

---

## PHASE 6: Service Layer Implementation

**Objective:** Create service layer that uses repositories, implement business logic.

**Files Modified:**
```
NEW: src/services/course.service.js
NEW: src/services/lesson.service.js
NEW: src/services/enrollment.service.js
NEW: src/services/subscription.service.js
NEW: src/services/quiz.service.js
NEW: src/services/analytics.service.js
NEW: src/services/notification.service.js
NEW: src/services/payment.service.js
NEW: src/services/liveSession.service.js
NEW: src/services/review.service.js
NEW: src/services/support.service.js
NEW: src/services/chargeCode.service.js
NEW: src/services/referral.service.js
```

**Database Impact:** NONE — Services call repositories which don't affect production yet.

**API Impact:** NONE — Services aren't wired to routes yet.

---

## PHASE 7: Route/Controller Refactoring

**Objective:** Create controllers and wire services to routes.

**Files Modified:**
```
NEW: src/controllers/course.controller.js
NEW: src/controllers/lesson.controller.js
NEW: src/controllers/quiz.controller.js
NEW: src/controllers/enrollment.controller.js
NEW: src/controllers/payment.controller.js
NEW: src/controllers/user.controller.js
NEW: src/controllers/auth.controller.js
NEW: src/controllers/notification.controller.js
NEW: src/routes/course.routes.js
NEW: src/routes/lesson.routes.js
NEW: src/routes/auth.routes.js
NEW: src/routes/user.routes.js
NEW: src/routes/admin.routes.js
NEW: src/routes/index.js
MODIFY: app.js (mount new routes alongside old)
```

**Database Impact:** NONE — Still using legacy read/write paths.

**API Impact:** New route files created. Old routes still work.

**Rollback Strategy:** Unmount new routes from app.js.

---

## PHASE 8: Read Switch

**Objective:** Switch read operations from legacy to V2.

**Files Modified:**
```
MODIFY: app.js (V2 readData → reads from Firestore collections)
MODIFY: All middleware that reads data
```

**Database Impact:** NONE — Reads are read-only.

**API Impact:** All read endpoints now return V2 data.

**Rollback Strategy:** Revert `readData` to use legacy path.

---

## PHASE 9: Write Switch

**Objective:** Switch write operations from legacy to V2.

**Files Modified:**
```
MODIFY: app.js (V2 writeData → writes to Firestore collections)
MODIFY: All route handlers that write data
```

**Database Impact:** Writes go to V2 collections going forward.

**API Impact:** All write endpoints now modify V2 data.

**Rollback Strategy:** Revert `writeData` to use legacy path.

---

## PHASE 10: Archive + Cleanup

**Objective:** Remove legacy code paths, update documentation.

**Files Modified:**
```
MODIFY: firebase-admin.js (remove legacy collections from FIRESTORE_COLLECTIONS)
MODIFY: AGENTS.md (update architecture documentation)
DELETE: services/firestore/ (legacy firestore adapter, if fully replaced)
```

**Database Impact:** Legacy data kept as read-only backup.

**API Impact:** Remove dual-read/write code paths.

**Rollback Strategy:** Restore deleted files from git, unarchive legacy data.
