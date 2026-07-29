# Legacy Cleanup Guide

## Ready for Removal (Post-Migration)

### 1. Firebase RTDB Dependencies

| File | What | Replace with |
|------|------|-------------|
| `firebase-admin.js` | `fbDb` (RTDB ref), `fbAuth`, `readData()`, `writeData()`, `updateData()` | V2 service layer + Firestore admin SDK |
| `firebase-admin.js` | `ENABLE_DUAL_WRITE`, `USE_RTDB_FALLBACK` flags | Remove after migration validated |
| `firebase-admin.js` | `localStore` (in-memory cache) | Remove — V2 uses Firestore directly |

### 2. Settings

| File | What | Replace with |
|------|------|-------------|
| `firebase-admin.js` | `settings` in `RTDB_REALTIME` | `SettingService` → Firestore `settings_v2` |
| `app.js` line ~707 | `readData('settings')` fallback in middleware | Already replaced with `settingService.getSettings()` |

### 3. Courses

| File | What | Replace with |
|------|------|-------------|
| `firebase-admin.js` | `courses` in `FIRESTORE_COLLECTIONS` | `CourseService` → Firestore `courses` |
| `app.js` | All routes using `readData('courses')` | V2 API `/api/v2/courses` |

### 4. Users

| File | What | Replace with |
|------|------|-------------|
| `firebase-admin.js` | `users` in `FIRESTORE_COLLECTIONS` | `UserService` → Firestore `users` |
| `firebase-admin.js` | `readUserById()` | `UserService.get()` |
| `app.js` | All routes using `readData('users')` | V2 API `/api/v2/users` |

### 5. Nested Data Extracted

| Legacy Embedded Field | V2 Collection | Status |
|----------------------|--------------|--------|
| `users[].enrollments{}` | `enrollments` | Phase 4 migration |
| `users[].progress{}` | `studentProgress` + `studentLessonProgress` | Phase 4 migration |
| `users[].payments[]` | `payments` | Phase 4 migration |
| `users[].reviews[]` | `courseRatings` | Phase 4 migration |
| `courses[].sections[]` | `units`, `lessons`, `lessonVideos`, `lessonFiles` | Phase 3 migration |
| `courses[].quiz` | `quizzes` + `questions` | Phase 3 migration |
| `questionBanks[].questions[]` | Keep embedded (or extract to `questions` with source field) | Phase 5 |
| `supportTickets[].replies[]` | Keep embedded | As-is |

### 6. Deprecated Functions (firebase-admin.js)

```javascript
// DEPRECATED: Use services/* instead
readData(key)        → service.list() / service.get()
writeData(key, data) → service.create() / service.update()
readUserById(id)     → UserService.get(id)
updateData(path, partial) → service.update()
sendFCM()            → NotificationService.send()
sendFCMToRole()      → NotificationService.sendToRole()
```

### 7. Migration Status

| Phase | Collections | Status | API Ready |
|-------|-----------|--------|-----------|
| 2 | `settings_v2` | ✅ Done | ✅ `/api/v2/settings` |
| 3 | `courses`, `units`, `lessons`, `lessonVideos`, `lessonFiles`, `quizzes`, `questions` | ✅ Done | ✅ `/api/v2/courses` |
| 4 | `users`, `enrollments`, `studentProgress`, `studentLessonProgress`, `payments`, `courseRatings`, `studentNotes`, `studentBookmarks`, `studentExamAttempts`, `activityLogs`, `userNotifications`, `studentFlags` | ✅ Done | ✅ `/api/v2/users` |
| 5 | `questionBanks`, `parentInvites`, `subscriptions`, `chargeCodes`, `supportTickets`, `announcements`, `subscriptionPayments`, `liveSessions`, `subRequests`, `reviews`, `notifications` | ✅ Done | ✅ `/api/v2/{resource}` |
| 6 | Service Layer | ✅ Done | ✅ |
| 7 | API Wiring | ✅ Done | ✅ `/api/v2` mounted |
| 8 | Cleanup Prep | 📝 Here | — |

### 8. Cleanup Order (When Ready)

1. **Dry-run**: Run all migrations, validate results
2. **Toggle**: Set `V2_ENABLED=true` in settings, verify app works
3. **Monitor**: Watch for errors in V2 API responses
4. **Remove**: Delete legacy readData/writeData code paths
5. **Archive**: Remove `scripts/seed-firebase.js`, unused EJS templates
