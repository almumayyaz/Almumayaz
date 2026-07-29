# DATABASE RESTRUCTURE PLAN — V2 Architecture

## Overview

Complete normalization of the Almumayaz database from embedded document structures to fully normalized Firestore collections with strict layered backend architecture.

## Architecture Principles

1. **Firestore is the SINGLE permanent database** for all business data
2. **RTDB is allowed ONLY** for: presence, online status, live chat, live attendance, whiteboard sync, temporary live session state
3. **No embedded entities** — every entity owns its own Firestore document
4. **No nested business objects** — lessons are NOT inside courses, questions are NOT inside quizzes
5. **Relationships use document IDs** — no embedded references
6. **No oversized documents** — no document exceeds Firestore's 1MB limit
7. **Strict layered backend** — Route → Controller → Service → Repository → Firestore

## Database Split

### Firestore (All Business Data)

| Collection | Description |
|---|---|
| `users` | Student, teacher, admin, parent accounts |
| `grades` | Grade levels (e.g. "الأول الإعدادي") |
| `subjects` | Subject/course categories |
| `courses` | Course metadata only (no embedded lessons) |
| `units` | Units/sections within a course |
| `lessons` | Individual lessons (no embedded videos/files) |
| `lessonVideos` | Video references for each lesson |
| `lessonFiles` | File references (PDF) for each lesson |
| `quizzes` | Quiz metadata with question references |
| `questions` | Individual questions (standalone documents) |
| `questionBanks` | Categorized question collections |
| `subscriptions` | Subscription plans/offers |
| `enrollments` | Student ↔ course enrollment records |
| `payments` | Payment records |
| `paymentReceipts` | Uploaded payment proof images |
| `studentProgress` | Per-course student progress |
| `studentLessonProgress` | Per-lesson student progress |
| `studentExamAttempts` | Quiz/exam attempt records |
| `studentBookmarks` | Student bookmarked lessons |
| `studentNotes` | Student personal notes on lessons |
| `notifications` | Notification records (persistent log) |
| `notificationLogs` | FCM delivery logs |
| `reviews` | Review courses/lessons |
| `announcements` | Platform announcements |
| `supportTickets` | Support ticket with replies subcollection |
| `settings` | Platform configuration (key-value) |
| `featureFlags` | Feature toggle flags |
| `activityLogs` | Admin/user activity audit log |
| `parentInvites` | Parent invitation records |
| `chargeCodes` | Promo/charge codes |
| `analytics` | Aggregated analytics data |
| `systemStats` | System performance statistics |

### RTDB (Real-Time Only)

| Path | Description |
|---|---|
| `presence/<userId>` | Online/offline presence |
| `chatMessages/<chatId>/<messageId>` | Real-time chat messages |
| `liveSessionAttendance/<sessionId>/<userId>` | Live session join/leave tracking |
| `liveSessionState/<sessionId>` | Temporary live session state |
| `whiteboard/<sessionId>` | Whiteboard sync data |

## Document Standard

Every Firestore document MUST contain:

```
id: string (globally unique)
createdAt: Timestamp (server timestamp)
updatedAt: Timestamp (server timestamp)
createdBy: string (user ID reference)
updatedBy: string (user ID reference)
status: 'active' | 'inactive' | 'archived'
version: number (monotonically increasing)
deleted: boolean (soft delete flag)
deletedAt: Timestamp | null
deletedBy: string | null
```

## ID Strategy

- All IDs are globally unique, auto-generated strings
- Never use titles, Arabic text, or sequential numbers as IDs
- Format: `<prefix>_<timestamp>_<random>` or Firestore auto-ID
- Prefix examples: `user_`, `course_`, `lesson_`, `quiz_`, etc.

## Relationship Model

All relationships use document ID references:

```
Course → units[]: [unitId1, unitId2, ...]
Unit → lessons[]: [lessonId1, lessonId2, ...]
Lesson → videos[]: [videoId1, videoId2, ...]
Lesson → files[]: [fileId1, fileId2, ...]
Quiz → questions[]: [questionId1, questionId2, ...]
Enrollment → user: userId, course: courseId
Progress → user: userId, course: courseId
Attempt → user: userId, quiz: quizId
```

## Data Flow

```
Client Request
    ↓
Express Route (validation, params)
    ↓
Controller (HTTP handling, response formatting)
    ↓
Service (business logic, validation, orchestration)
    ↓
Repository (CRUD operations, queries)
    ↓
Firestore SDK (document reads/writes)
```

## Migration Strategy

1. Create new V2 collections alongside existing data
2. Run migration scripts to populate V2 collections from embedded data
3. Validate migrated data integrity
4. Switch reads to V2 collections (dual-read during transition)
5. Switch writes to V2 collections (dual-write during transition)
6. Archive legacy read/write paths
7. Never delete legacy data automatically

## Rollback Strategy

Every phase has a rollback procedure:
- Keep legacy data intact until phase is verified
- Maintain ability to switch reads/writes back to legacy
- Document exact rollback commands for each phase
