# Implementation Audit — V2 Architecture

> **Date:** 2026-07-27
> **Scope:** Complete verification of Phases 1-8
> **Methodology:** Static code analysis, architecture review, security audit
> **Status:** ❌ **DO NOT MIGRATE** — Blocking issues found

---

## Architecture Score: 6.5 / 10

| Criterion | Score | Notes |
|-----------|-------|-------|
| Layering | 7/10 | Services → Repositories → Firestore is correct. But services bypass repos (setting.service.js imports firebase-admin directly) |
| Separation of concerns | 7/10 | Business logic in services, data access in repos. Some logic leaks in migrations (inline transformation). |
| Dependency direction | 8/10 | No circular deps. All arrows point inward (API → Services → Repositories → DB). |
| Error handling | 6/10 | V2 API catches errors via `wrap()`. But `_dualWrite` swallows all failures. No structured error reporting. |
| Testability | 4/10 | No dependency injection. All repos/services are singletons. Cannot mock for unit tests without module-level hacks. |

---

## Repository Score: 3 / 10

**The repository layer has a critical bug that renders it entirely non-functional.**

### `_base.js` — All properties prefixed with `_` but referenced without it

| Method | Line | References | Should Reference | Impact |
|--------|------|-----------|-----------------|--------|
| `query()` | 115 | `this.collection` | `this._collection` or `this._init()` | **ALL** `list()`, `findBy*()`, `paginate()` calls crash |
| `count()` | 152 | `this.collection` | `this._collection` or `this._init()` | **ALL** `count()` calls crash |
| `batchCreate()` | 170 | `this.db` | `this._db` | `batchCreate()` always crashes |
| `batchUpdate()` | 189 | `this.db` | `this._db` | `batchUpdate()` always crashes |
| `batchDelete()` | 210 | `this.db` | `this._db` | `batchDelete()` always crashes |
| `transaction()` | 223 | `this.db` | `this._db` | `transaction()` always crashes |

**Only `get()`, `create()`, `update()`, `softDelete()`, `hardDelete()`, `exists()` work** — because they go through `_doc()` which correctly calls `this._init()`.

### How this affects everything

| Consumer | What Breaks |
|----------|-------------|
| `course.service.js` `getFull()` | `findByCourse()`, `findByLesson()`, `findByQuiz()` |
| `user.service.js` `getProfile()` | `findByUser()` |
| `enrollment.service.js` `enroll()` | `findByUserAndCourse()` |
| `progress.service.js` `completeLesson()` | `findByUserAndCourse()`, `findByCourse()` |
| `quiz.service.js` `gradeAttempt()` | `findByQuiz()`, `getAttemptCount()` |
| ALL V2 API list endpoints | Every `service.list()` call |
| `BaseRepository.paginate()` | All pagination |

### Collection Name Mapping

All 31 repositories use correct collection names (e.g., `courses`, `users`, `units`, `enrollments`).

---

## Service Score: 5 / 10

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| S1 | **`setting.service.js` imports `firebase-admin` directly** — layer violation | 🔴 Critical | `setting.service.js:119,130` |
| S2 | **`payment.service.js` `approvePayment()` creates enrollment WITHOUT progress record** — data corruption | 🔴 Critical | `payment.service.js:41-48` |
| S3 | **Duplicate basic + domain service exports** — easy to import wrong one | 🟠 High | `services/index.js:5-15 vs 76-83` |
| S4 | **`update()` and `delete()` double-read** — `get()` called twice per operation | 🟠 High | `services/_base.js:57-64` |
| S5 | **`completeLesson()` allows duplicate `lessonId`** — percentage > 100% | 🟠 High | `progress.service.js:17` |
| S6 | **`completeLesson()` fetches ALL lessons just to count** | 🟠 High | `progress.service.js:18` |
| S7 | **`gradeAttempt()` race condition on `attemptNumber`** | 🟠 High | `quiz.service.js:41` |
| S8 | **`enroll()` doesn't validate `courseId` exists** | 🟡 Medium | `enrollment.service.js:13-37` |
| S9 | **`toggleActive()` race condition** | 🟡 Medium | `course.service.js:59-62` |
| S10 | **`_dualWrite` swallows ALL failures silently** | 🟡 Medium | `setting.service.js:113-123` |
| S11 | **`liveSession.service.js` uses raw `new BaseRepository(...)`** | 🟡 Medium | `liveSession.service.js:6` |

---

## API Score: 4 / 10

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| A1 | **`GET /users/:id` no auth middleware** — anyone can read any user | 🔴 Critical | `v2.js:99` |
| A2 | **`GET /users/:id/enrollments` no auth** | 🔴 Critical | `v2.js:105` |
| A3 | **`GET /progress/:userId/:courseId` no auth** | 🔴 Critical | `v2.js:133` |
| A4 | **`POST /payments` no auth** — anyone can create payments | 🔴 Critical | `v2.js:179` |
| A5 | **`POST /enrollments` no body validation** — missing `userId` or `courseId` | 🟠 High | `v2.js:111-114` |
| A6 | **All list endpoints missing pagination** — 13 endpoints return all docs | 🟠 High | `v2.js:43-252` (see full list below) |
| A7 | **`requireV2Enabled` soft-fail bypass** — catch calls `next()` on error | 🟠 High | `v2.js:18` |
| A8 | **No user ID validation** — horizontal privilege escalation on all user-specific endpoints | 🔴 Critical | `v2.js:99,105,133,150` |
| A9 | **Error messages leak in production** | 🟡 Medium | `v2.js:325` |
| A10 | **No CSRF protection on V2 API specifically** (relies on global middleware) | 🟡 Medium | `v2.js` |

### List endpoints missing pagination:
- `GET /users`, `GET /courses`, `GET /enrollments`, `GET /payments`,
- `GET /notifications`, `GET /announcements`, `GET /tickets`,
- `GET /charge-codes`, `GET /subscriptions`, `GET /live-sessions`,
- `GET /reviews`, `GET /courses/:courseId/lessons`

---

## Migration Score: 3 / 10

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| M1 | **`migrate-courses.js` batch not refreshed after flush** — breaks after 400 ops | 🔴 Critical | `migrate-courses.js:174` |
| M2 | **Rollback destroys ALL collections with zero safety** — no `--confirm`, no backup | 🔴 Critical | `index.js:56-78` |
| M3 | **Rollback targets same collections V2 API writes to** — would delete production data | 🔴 Critical | `index.js:11-13` |
| M4 | **Phase 3, 4, 5 not idempotent** — running twice overwrites data | 🟠 High | All `migrate-*.js` |
| M5 | **All migrations load entire collections into memory** — potential OOM at scale | 🟠 High | `migrate-courses.js:21`, `migrate-users.js:36` |
| M6 | **`migrate-misc.js` dead code** — `copyCollection()` defined but unused | 🟡 Medium | `migrate-misc.js:20-53` |

---

## Security Score: 3 / 10

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| X1 | **248 `readData()` calls in app.js** — every call is a potential bypass of V2 access control | 🔴 Critical | `app.js` (passim) |
| X2 | **123 `writeData()` calls in app.js** — legacy writes bypass V2 validation | 🔴 Critical | `app.js` (passim) |
| X3 | **No auth on critical V2 endpoints** (see A1-A4) | 🔴 Critical | `v2.js` |
| X4 | **Horizontal privilege escalation** — no userId validation against session | 🔴 Critical | `v2.js` |
| X5 | **`admin` object exported from `firebase-admin.js`** — enables direct SDK access | 🟠 High | `firebase-admin.js:574` |
| X6 | **No permission checks in service layer** — all access control is API-middleware-only | 🟠 High | All services |
| X7 | **CSRF check trusts `Host` header** — can be manipulated | 🟠 High | `app.js:189` |
| X8 | **`admin.database()` called directly 13+ times** in app.js — bypasses ALL abstractions | 🟠 High | `app.js:5337,7349-7604` |

---

## Performance Score: 3 / 10

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| P1 | **`CourseService.getFull()` N+1 explosion** — ~55 queries for a 25-lesson course | 🔴 Critical | `course.service.js:15-41` |
| P2 | **`UserService.getStudentsWithProgress()` 1 + 2N queries** | 🔴 Critical | `user.service.js:48-65` |
| P3 | **No Firestore composite indexes** — no `firestore.indexes.json` exists | 🟠 High | Project root |
| P4 | **`query()` has no default limit** — list endpoints return ALL docs | 🟠 High | `repositories/_base.js:113` |
| P5 | **`readData('users')` reads every user on cache miss** — O(N) every 10s | 🟠 High | `firebase-admin.js:193` |
| P6 | **Cache is per-Vercel-instance** — stale data served for up to 20s | 🟠 High | `firebase-admin.js` |
| P7 | **`GET /courses/:id?full=true` triggers N+1 explosion** | 🔴 Critical | `v2.js:54-56` |
| P8 | **Cold start = 2-5s latency** (Firebase Admin init + empty cache) | 🟠 High | `firebase-admin.js` |

---

## Code Quality Score: 6 / 10

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| Q1 | **`_base.js` `this.collection` vs `this._collection` typo** — 6 methods broken | 🔴 Critical | `repositories/_base.js:115,152,170,189,210,223` |
| Q2 | **`migrate-misc.js` dead `copyCollection()` function** | 🟡 Medium | `migrate-misc.js:20-53` |
| Q3 | **Case inconsistency** — `courseService` vs `CourseService` mixed in same file | 🟡 Medium | `services/index.js`, `v2.js` |
| Q4 | **`questionBank` transform flag set but unused** | 🟢 Info | `migrate-misc.js:6` |

---

## Summary Scores

| Area | Score | Critical | High | Medium | Low |
|------|-------|----------|------|--------|-----|
| **Architecture** | 6.5/10 | 0 | 1 | 2 | 1 |
| **Repository** | 3/10 | 6 | 0 | 0 | 0 |
| **Service** | 5/10 | 2 | 5 | 4 | 1 |
| **API** | 4/10 | 4 | 3 | 3 | 0 |
| **Migration** | 3/10 | 3 | 2 | 1 | 0 |
| **Security** | 3/10 | 4 | 4 | 0 | 0 |
| **Performance** | 3/10 | 3 | 5 | 0 | 0 |
| **Code Quality** | 6/10 | 1 | 0 | 2 | 1 |
| **TOTAL** | **4.2/10** | **23** | **20** | **12** | **3** |

---

## Critical Issues (23)

### BLOCKING — Fix before any migration or V2 enablement:

| ID | Area | Issue | Where |
|----|------|-------|-------|
| **C1** | Repository | `query()` uses `this.collection` (undefined). ALL list/find queries crash at runtime. | `repositories/_base.js:115` |
| **C2** | Repository | `count()` uses `this.collection` (undefined). ALL count queries crash. | `repositories/_base.js:152` |
| **C3** | Repository | `batchCreate()` uses `this.db` (undefined). Batch creates crash. | `repositories/_base.js:170` |
| **C4** | Repository | `batchUpdate()` uses `this.db` (undefined). Batch updates crash. | `repositories/_base.js:189` |
| **C5** | Repository | `batchDelete()` uses `this.db` (undefined). Batch deletes crash. | `repositories/_base.js:210` |
| **C6** | Repository | `transaction()` uses `this.db` (undefined). Transactions crash. | `repositories/_base.js:223` |
| **C7** | Migration | `migrate-courses.js` batch not refreshed after flush. Partial data loss. | `migrate-courses.js:174-177` |
| **C8** | Migration | Rollback has zero safety checks. Destroys production data. | `index.js:56-78` |
| **C9** | Migration | Rollback targets same collections as V2 API production use. | `index.js:11-13` |
| **C10** | API | `GET /users/:id` — no auth, any user's profile exposed. | `v2.js:99` |
| **C11** | API | `GET /users/:id/enrollments` — no auth, any user's enrollments exposed. | `v2.js:105` |
| **C12** | API | `GET /progress/:userId/:courseId` — no auth, any user's progress exposed. | `v2.js:133` |
| **C13** | API | `GET /progress/:userId/:courseId/certificate` — no auth, anyone gets cert data. | `v2.js:150` |
| **C14** | API | `POST /payments` — no auth, anyone can create payment records. | `v2.js:179` |
| **C15** | API | Horizontal privilege escalation — userId in URL not validated against session. | `v2.js:99,105,133,150` |
| **C16** | Service | `setting.service.js` imports `firebase-admin` directly — layer violation. | `setting.service.js:119,130` |
| **C17** | Service | `approvePayment()` creates enrollment WITHOUT progress record → data corruption. | `payment.service.js:41-48` |
| **C18** | Performance | `getFull()` N+1: ~55 queries for a 25-lesson course. | `course.service.js:15-41` |
| **C19** | Performance | `getStudentsWithProgress()`: 1 + 2N queries for N students. | `user.service.js:48-65` |
| **C20** | Performance | `GET /courses/:id?full=true` triggers N+1 explosion. | `v2.js:54-56` |
| **C21** | Security | 248 `readData()` calls in app.js — legacy bypasses all V2 access control. | `app.js` (passim) |
| **C22** | Security | 123 `writeData()` calls in app.js — legacy writes bypass V2 validation. | `app.js` (passim) |
| **C23** | Security | No permission checks in service layer — anyone with API access can read/write anything. | All services |

---

## Recommended Fixes (Before Migration)

### Fix Order — Highest Priority First

| Order | Fix | ID | Effort |
|-------|-----|----|--------|
| 1 | **`_base.js`**: Change `this.collection` → `this._collection`, `this.db` → `this._db` in all 6 methods. | C1-C6 | 5 min |
| 2 | **`migrate-courses.js`**: Add `batch = fbDb.batch()` after `await batch.commit()` on flush. | C7 | 2 min |
| 3 | **`migrate-courses.js`**: Make idempotent — check `doc.exists` before `batch.set()`. | M4 | 10 min |
| 4 | **`v2.js`**: Add `authOnly` middleware to all unprotected routes (A1-A5). | C10-C14 | 10 min |
| 5 | **`v2.js`**: Add userId-vs-session validation for user-specific endpoints. | C15 | 15 min |
| 6 | **`v2.js`**: Add pagination defaults (limit: 50) to all list endpoints. | A6, P4 | 20 min |
| 7 | **`rollbackPhase()`**: Add `--confirm` flag, document count summary, NODE_ENV check. | C8-C9 | 15 min |
| 8 | **`payment.service.js`**: Fix `approvePayment()` to create progress record. | C17 | 5 min |
| 9 | **`setting.service.js`**: Remove direct `firebase-admin` import — use repository. | C16 | 10 min |
| 10 | **`setting.service.js`**: Fix `_dualWrite` to propagate errors instead of swallowing. | S10 | 5 min |
| 11 | **`progress.service.js`**: Deduplicate `lessonId` before adding to `completedLessons`. | S5 | 2 min |
| 12 | **`course.service.js`**: Optimize `getFull()` — fetch videos/files per-course not per-lesson. | C18 | 30 min |
| 13 | **Create `firestore.indexes.json`**: Add composite indexes for all `where` + `orderBy` patterns. | P3 | 30 min |
| 14 | **`v2.js`**: Return generic error messages in production (mask internal details). | A9 | 5 min |
| 15 | **`services/index.js`**: Rename duplicate exports to clarify basic vs domain services. | S3 | 10 min |

### Fix Order — Lower Priority

| Order | Fix | ID | Effort |
|-------|-----|----|--------|
| 16 | **Create `liveSession.repository.js`** instead of raw `BaseRepository` in service. | S11 | 15 min |
| 17 | **`migrate-misc.js`**: Remove dead `copyCollection()` function. | M6 | 2 min |
| 18 | **`quiz.service.js`**: Use transaction for `attemptNumber` to avoid race. | S7 | 15 min |
| 19 | **`enrollment.service.js`**: Validate `courseId` exists before enrolling. | S8 | 5 min |
| 20 | **`course.service.js`**: Use `FieldValue.increment` for `toggleActive()`. | S9 | 5 min |
| 21 | **`user.service.js`**: Fix `safeCreate()` TOCTOU race on duplicate email. | (info) | 10 min |
| 22 | **`_base.js` services**: Fix double-read in `update()` and `delete()`. | S4 | 15 min |
| 23 | **`v2.js`**: Standardize casing — use only PascalCase or camelCase consistently. | Q3 | 10 min |
| 24 | **`migrate-users.js`**: Replace `Date.now()` fallback IDs with `crypto.randomUUID()`. | (info) | 5 min |
| 25 | **Add `firestore.rules`**: V2-specific security rules for all collections. | — | 60 min |

---

## Blocking Issues Before Migration

**The following issues MUST be fixed before ANY migration is executed or V2 API is enabled:**

1. **🔴 `_base.js` typo bug** (C1-C6) — The entire repository layer is non-functional. No V2 API endpoint that uses `list()`, `query()`, `paginate()`, `count()`, `batchCreate()`, `batchUpdate()`, `batchDelete()`, or `transaction()` will work. Only `get()`, `create()`, `update()`, `softDelete()`, and hardDelete()` function correctly.

2. **🔴 `migrate-courses.js` flush bug** (C7) — After the first batch flush, the batch object is not refreshed. All subsequent writes silently fail, resulting in a partial migration where only the first 400 operations succeed.

3. **🔴 Rollback destroys production data** (C8-C9) — The rollback deletes all documents in collections like `courses`, `users`, `enrollments`, `payments` with zero safety checks. If the V2 API is already running alongside legacy, rollback destroys live data.

4. **🔴 No auth on V2 API** (C10-C15) — 4 endpoints expose sensitive user data without authentication. Payment creation requires no auth. No userId validation means horizontal privilege escalation.

5. **🔴 `approvePayment()` data corruption** (C17) — Students approved via payment have no progress record, causing `completeLesson()` to crash with "Progress not found" for those students.

---

## Detailed File-Fix Map

| File | Line(s) | Fix Description |
|------|---------|----------------|
| `src/repositories/_base.js` | 115 | `this.collection` → `this._collection` |
| `src/repositories/_base.js` | 152 | `this.collection` → `this._collection` |
| `src/repositories/_base.js` | 170 | `this.db` → `this._db` |
| `src/repositories/_base.js` | 189 | `this.db` → `this._db` |
| `src/repositories/_base.js` | 210 | `this.db` → `this._db` |
| `src/repositories/_base.js` | 223 | `this.db` → `this._db` |
| `src/migrations/migrate-courses.js` | ~174 | Add `batch = fbDb.batch()` after `await batch.commit()` |
| `src/migrations/index.js` | 56-78 | Add `--confirm` flag + env check + doc count summary |
| `src/api/v2.js` | 99 | Add `authOnly` middleware |
| `src/api/v2.js` | 105 | Add `authOnly` middleware |
| `src/api/v2.js` | 133 | Add `authOnly` middleware + userId validation |
| `src/api/v2.js` | 150 | Add `authOnly` middleware + userId validation |
| `src/api/v2.js` | 179 | Add `authOnly` middleware |
| `src/api/v2.js` | 43-252 | Add `limit` default to all list endpoints |
| `src/api/v2.js` | 325 | Use generic error in production |
| `src/services/payment.service.js` | 41-48 | Add `this.progressRepo.create()` call |
| `src/services/setting.service.js` | 119,130 | Replace direct firebase-admin calls with repository |
| `src/services/setting.service.js` | 113-123 | Don't swallow errors |
| `src/services/progress.service.js` | 17 | Check `!completedLessons.includes(lessonId)` before push |
| `src/services/course.service.js` | 15-41 | Batch-fetch videos/files per-course not per-lesson |
| `src/services/quiz.service.js` | 41 | Use transaction for attemptNumber |
| `src/services/_base.js` (services) | 57-64 | Avoid double-read in update/delete |
| `firebase-admin.js` — export | 574 | Remove `admin` from exports (migration concern) |

---

## End of Report
