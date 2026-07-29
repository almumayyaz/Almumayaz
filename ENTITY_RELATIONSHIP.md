# ENTITY RELATIONSHIP DIAGRAM & DATA MODEL ANALYSIS

## Executive Summary
This document provides a **comprehensive analysis** of the **real data model** in the Almumayaz V8 project. It includes:

- **Current ER Diagram** (visual representation of entities and relationships)
- **JSON Schema** (exact structure for each entity)
- **Business Relationships** (One-to-One, One-to-Many, Many-to-Many)
- **Broken Relationships** (missing foreign keys, orphan records, circular references)
- **CRUD Matrix** (APIs vs Entities)
- **Critical Findings** (data duplication, hidden dependencies, scalability issues)

### Key Findings
1. **Mixed Storage Model**: Entities are stored in Firestore, RTDB, or both, leading to **inconsistent access patterns**.
2. **Embedded Structures**: Many child entities (e.g., lessons, videos, questions) are **embedded** rather than **referenced**, making updates and queries difficult.
3. **Deep Nesting**: Complex nested structures (e.g., `courses.lessons.videos`) create **query performance issues**.
4. **Orphan Records**: Many entities (e.g., notes, reviews, question banks) may become **orphaned** if parent entities are deleted.
5. **No Strong Relationships**: Relationships are often by ID only, without **foreign key constraints**.
6. **Dual-Write Complexity**: Some entities are written to **both Firestore and RTDB**, increasing inconsistency risks.
7. **No Versioning**: No version control for content changes (e.g., courses, lessons, question banks).
8. **Limited Metadata**: Many entities lack comprehensive metadata (e.g., videos, files, payments).

---

## Current ER Diagram

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryColor': '#ffdfd3', 'edgeLabelBackground':'#fff', 'tertiaryColor': '#fff'}}}%%
erd
    %% Entities
    Users["Users
---
id: string
uid: string
name: string
email: string
role: string
..."]
    Teachers["Teachers
---
(Users with role='teacher')"]
    Students["Students
---
(Users with role='student')"]
    Courses["Courses
---
id: string
title: string
stage: string
grade: string
..."]
    Units["Units
---
(Embedded in Courses as 'sections')"]
    Lessons["Lessons
---
(Embedded in Courses)"]
    Videos["Videos
---
(Embedded in Lessons)"]
    Files["Files
---
(Embedded in Lessons/Notes)"]
    Exams["Exams
---
(Embedded in Courses/Lessons/Reviews)"]
    Questions["Questions
---
(Embedded in Exams/Question Banks)"]
    QuestionBanks["Question Banks
---
id: string
courseId: string
title: string
..."]
    Subscriptions["Subscriptions
---
id: string
name: string
price: string
..."]
    Payments["Payments
---
id: string
userId: string
amount: number
status: string
..."]
    Notifications["Notifications
---
id: string
title: string
content: string
..."]
    Chats["Chats
---
id: string
participants: string[]
..."]
    LiveSessions["Live Sessions
---
id: string
courseId: string
zoomMeetingId: string
..."]
    Attendance["Attendance
---
(Embedded in RTDB: liveSessionAttendance/{sessionId})"]
    Reviews["Reviews
---
id: string
courseId: string
title: string
..."]
    Settings["Settings
---
(Global settings in RTDB)"]

    %% Relationships
    Users ||--o{ Students : "role='student'"
    Users ||--o{ Teachers : "role='teacher'"
    Users ||--o{ Payments : "1:N (userId)"
    Users ||--o{ Notifications : "N:M (FCM)"
    Users ||--o{ Chats : "N:M (participants)"
    Users ||--o{ LiveSessions : "N:M (attendance)"
    
    Courses ||--o{ Units : "1:N (embedded)"
    Courses ||--o{ Lessons : "1:N (embedded)"
    Courses ||--o{ QuestionBanks : "1:N (courseId)"
    Courses ||--o{ Reviews : "1:N (courseId)"
    Courses ||--o{ LiveSessions : "1:N (courseId)"
    
    Units ||--o{ Lessons : "1:N (lessons array)"
    
    Lessons ||--o{ Videos : "1:N (embedded)"
    Lessons ||--o{ Files : "1:N (embedded)"
    Lessons ||--o{ Exams : "1:1 (embedded)"
    
    Exams ||--o{ Questions : "1:N (embedded)"
    QuestionBanks ||--o{ Questions : "1:N (embedded)"
    Reviews ||--o{ Exams : "1:1 (embedded)"
    
    Subscriptions ||--o{ Users : "N:1 (subscriptionStatus)"
    
    LiveSessions ||--o{ Attendance : "1:N (RTDB)"
```

---

## JSON Schema

### Users
```json
{
  "id": "string (uid)",
  "uid": "string (Firebase UID)",
  "name": "string",
  "email": "string",
  "phone": "string",
  "parentPhone": "string",
  "grade": "string",
  "stage": "string (إعدادية|ثانوية|all)",
  "governorate": "string",
  "role": "string (student|teacher|admin|parent)",
  "subscriptionStatus": "string (active|inactive|pending)",
  "subscriptionStart": "timestamp|null",
  "subscriptionEnd": "timestamp|null",
  "subscribedStage": "string",
  "planName": "string",
  "planPeriod": "string",
  "referralCode": "string",
  "referredBy": "string",
  "fcmToken": "string",
  "referralDiscount": "number",
  "createdAt": "timestamp",
  "lastLogin": "timestamp",
  "progress": {
    "courseId": {
      "lessonId": {
        "watchTime": "number",
        "status": "string",
        "quizScore": "number",
        "completedAt": "timestamp"
      }
    }
  },
  "emailVerified": "boolean"
}
```

### Courses
```json
{
  "id": "string",
  "title": "string",
  "subtitle": "string",
  "description": "string",
  "icon": "string (Font Awesome icon)",
  "color": "string (hex color)",
  "gradient": "string (CSS gradient)",
  "stage": "string (إعدادية|ثانوية|all)",
  "grade": "string",
  "semester": "string (first|second|all)",
  "sections": [
    {
      "id": "string",
      "name": "string",
      "lessons": ["string (lesson IDs)"]
    }
  ],
  "lessons": [
    {
      "id": "string",
      "title": "string",
      "description": "string",
      "videos": [
        {
          "title": "string",
          "url": "string (YouTube URL)",
          "duration": "string"
        }
      ],
      "pdfFiles": [
        {
          "title": "string",
          "url": "string (PDF URL)"
        }
      ],
      "isFree": "boolean",
      "guestVisible": "boolean",
      "sectionId": "string (section ID)",
      "quiz": {
        "enabled": "boolean",
        "passPct": "number",
        "questions": [
          {
            "id": "string",
            "text": "string",
            "type": "string (mcq|truefalse)",
            "options": ["string"],
            "correctAnswer": "string|boolean",
            "explanation": "string"
          }
        ]
      }
    }
  ],
  "quiz": {
    "title": "string",
    "questions": [
      {
        "id": "string",
        "text": "string",
        "type": "string (mcq|truefalse)",
        "options": ["string"],
        "correctAnswer": "string|boolean",
        "explanation": "string"
      }
    ],
    "timerMinutes": "number|null"
  }
}
```

### Question Banks
```json
{
  "id": "string",
  "courseId": "string",
  "stage": "string",
  "grade": "string",
  "title": "string",
  "description": "string",
  "timerMinutes": "number|null",
  "order": "number",
  "questions": [
    {
      "id": "string",
      "text": "string",
      "type": "string (mcq|truefalse)",
      "options": ["string"],
      "correctAnswer": "string|boolean",
      "explanation": "string"
    }
  ],
  "createdAt": "timestamp"
}
```

### Reviews
```json
{
  "id": "string",
  "title": "string",
  "course": "string",
  "courseId": "string",
  "color": "string (hex color)",
  "icon": "string (Font Awesome icon)",
  "date": "string (YYYY-MM-DD)",
  "desc": "string",
  "videos": [
    {
      "title": "string",
      "url": "string (YouTube URL)"
    }
  ],
  "pdfFiles": [
    {
      "title": "string",
      "url": "string (PDF URL)"
    }
  ],
  "stage": "string (إعدادية|ثانوية|all)",
  "grade": "string",
  "order": "number",
  "isFree": "boolean",
  "quiz": {
    "id": "string",
    "title": "string",
    "questions": [
      {
        "id": "string",
        "text": "string",
        "type": "string (mcq|truefalse)",
        "options": ["string"],
        "correctAnswer": "string|boolean",
        "explanation": "string"
      }
    ],
    "timerMinutes": "number|null"
  }
}
```

### Live Sessions
```json
{
  "id": "string",
  "title": "string",
  "description": "string",
  "courseId": "string",
  "startTime": "timestamp",
  "endTime": "timestamp",
  "zoomMeetingId": "string",
  "zoomJoinUrl": "string",
  "zoomStartUrl": "string",
  "stage": "string",
  "grade": "string",
  "createdAt": "timestamp"
}
```

### Attendance (RTDB)
```json
{
  "userId": "string",
  "userName": "string",
  "joinTime": "timestamp",
  "leaveTime": "timestamp|null",
  "duration": "number (seconds)",
  "status": "string (present|absent|late)"
}
```

### Settings (RTDB)
```json
{
  "vodafoneCash": "string",
  "instaPay": "string",
  "contactPhone": "string",
  "contactEmail": "string",
  "contactAddress": "string",
  "contactWhatsapp": "string",
  "referralDiscount": "number",
  "currentSemester": "string (first|second)",
  "announcementsEnabled": "boolean"
}
```

---

## Business Relationships

### One-to-One
| **Entity A** | **Entity B** | **Relationship** | **Implementation** | **Issues** |
|--------------|--------------|------------------|---------------------|------------|
| Course       | Quiz          | One-to-One         | Embedded in `courses.quiz` | No direct access to quiz |
| Lesson       | Quiz          | One-to-One         | Embedded in `courses.lessons[{lessonId}].quiz` | No direct access to quiz |
| Review       | Quiz          | One-to-One         | Embedded in `reviews.quiz` | No direct access to quiz |

### One-to-Many
| **Entity A** | **Entity B** | **Relationship** | **Implementation** | **Issues** |
|--------------|--------------|------------------|---------------------|------------|
| User         | Payment       | One-to-Many        | `payments.userId` references `users.id` | No foreign key constraint |
| Course       | Lesson        | One-to-Many        | Embedded in `courses.lessons` | No direct access to lessons |
| Course       | Unit          | One-to-Many        | Embedded in `courses.sections` | Inconsistent naming (sections vs units) |
| Course       | Question Bank  | One-to-Many        | `questionBanks.courseId` references `courses.id` | Orphan records possible |
| Course       | Review        | One-to-Many        | `reviews.courseId` references `courses.id` | Orphan records possible |
| Course       | Live Session   | One-to-Many        | `liveSessions.courseId` references `courses.id` | Orphan records possible |
| Unit         | Lesson        | One-to-Many        | Embedded in `courses.sections[{sectionId}].lessons` | No direct access to lessons |
| Lesson       | Video         | One-to-Many        | Embedded in `courses.lessons[{lessonId}].videos` | No direct access to videos |
| Lesson       | File          | One-to-Many        | Embedded in `courses.lessons[{lessonId}].pdfFiles` | No direct access to files |
| Exam         | Question      | One-to-Many        | Embedded in `courses.quiz.questions` | No direct access to questions |
| Question Bank | Question      | One-to-Many        | Embedded in `questionBanks.questions` | No direct access to questions |
| Live Session  | Attendance     | One-to-Many        | RTDB: `liveSessionAttendance/{sessionId}/{userId}` | RTDB only, no Firestore backup |

### Many-to-Many
| **Entity A** | **Entity B** | **Relationship** | **Implementation** | **Issues** |
|--------------|--------------|------------------|---------------------|------------|
| User         | Chat          | Many-to-Many       | RTDB: `chats/{chatId}.participants` | RTDB only, no Firestore backup |
| User         | Live Session   | Many-to-Many       | RTDB: `liveSessionAttendance/{sessionId}/{userId}` | RTDB only, no Firestore backup |
| User         | Notification   | Many-to-Many       | FCM tokens + role-based notifications | No read status tracking |

---

## Broken Relationships

| **Issue** | **Entity** | **Problem** | **Impact** |
|------------|------------|-------------|------------|
| Missing Foreign Keys | Payments, Question Banks, Reviews, Live Sessions | Relationships are by ID only without constraints | Orphan records, data inconsistency |
| Orphan Records | Notes, Reviews, Question Banks, Live Sessions | No cascading delete when parent is deleted | Orphaned data in database |
| Circular References | None detected | - | - |
| Deep Nesting | Courses (lessons, sections, videos, quizzes) | Complex nested structures | Difficult to query and update |
| Embedded Objects | Lessons, Videos, Questions, Exams | Child entities are embedded rather than referenced | No direct access, difficult to update |
| Arrays That Should Be Collections | `courses.lessons`, `courses.sections`, `questionBanks.questions` | Arrays are used instead of subcollections | Limited query capabilities, difficult to scale |
| Collections That Should Be Subcollections | Question Banks, Reviews | Stored as root collections but logically belong to courses | Orphan records, no cascading deletes |
| No Direct Access | Lessons, Videos, Questions, Exams | Cannot access directly, only through parent entities | Difficult to query and update |
| Inconsistent Storage | Notifications, Chats, Attendance, Settings | Some entities use Firestore, some use RTDB, some use both | Inconsistent access patterns, dual-write complexity |
| No Versioning | Courses, Lessons, Question Banks | No version control for content changes | Difficult to track changes, no rollback capability |

---

## CRUD Matrix

| **Entity** | **Create API** | **Read API** | **Update API** | **Delete API** | **Pages** | **Components** |
|-------------|----------------|--------------|----------------|----------------|------------|-----------------|
| Users       | `POST /api/auth/firebase-register` | User data in login flow | User data in admin routes | None (soft delete) | `views/auth/login.ejs`, `views/admin/students.ejs` | Authentication components |
| Courses     | `POST /api/admin/courses` | Course data in student dashboard | `PUT /api/admin/courses/:id` | `DELETE /api/admin/courses/:id` | `views/admin/courses.ejs`, `views/student/courses.ejs` | Course management components |
| Lessons     | `POST /api/admin/courses/:id/lessons` | Through course data | Through course update API | Through course update API | `views/admin/courses.ejs` | Lesson management components |
| Question Banks | `POST /api/admin/question-banks` | Question bank data | `PUT /api/admin/question-banks/:id` | `DELETE /api/admin/question-banks/:id` | `views/admin/courses.ejs` | Question bank management components |
| Reviews     | `POST /api/admin/reviews` | Review data | `PUT /api/admin/reviews/:id` | `DELETE /api/admin/reviews/:id` | `views/admin/courses.ejs` | Review management components |
| Live Sessions | Not explicitly shown | Live session data | Not explicitly shown | Not explicitly shown | `views/admin/live-sessions.ejs` | Live session management components |
| Payments    | `POST /api/student/submit-payment` | Payment data | `PUT /api/admin/payments/:id` (implied) | Not explicitly shown | `views/admin/payments.ejs` | Payment management components |
| Notifications | `POST /api/admin/announcements` | Notification data | `PUT /api/admin/announcements/:id` | Not explicitly shown | Notification pages (implied) | Notification components |
| Chats       | Not explicitly shown (realtime) | Chat data | Not explicitly shown (realtime) | Not explicitly shown (realtime) | `views/admin/chat-list.ejs`, `views/admin/chat.ejs` | Chat components |
| Attendance  | Not explicitly shown (realtime) | Attendance data | Not explicitly shown (realtime) | Not explicitly shown (realtime) | Attendance pages (implied) | Attendance components |
| Settings    | None (initial setup) | Settings data | `POST /api/admin/settings` | None | `views/admin/settings.ejs` (implied) | Settings management components |

---

## Critical Findings

### 1. Where Are Lessons Stored?
- **Storage Location**: Embedded in `courses.lessons` array (Firestore only).
- **Exact Path**: `courses/{courseId}.lessons[{lessonId}]`.
- **Access**: Only through parent course.
- **Issue**: No direct access to lessons, making updates and queries difficult.

### 2. Where Are Videos Stored?
- **Storage Location**: Embedded in `courses.lessons.videos` array (Firestore only).
- **Exact Path**: `courses/{courseId}.lessons[{lessonId}].videos[{videoIndex}]`.
- **Access**: Only through parent lesson.
- **Issue**: No direct access to videos, making updates and queries difficult.

### 3. Where Are Files Stored?
- **Storage Location**: 
  - Embedded in `courses.lessons.pdfFiles` array (Firestore).
  - Referenced in `notes.fileUrl` (Firestore).
- **Exact Path**:
  - `courses/{courseId}.lessons[{lessonId}].pdfFiles[{fileIndex}]`.
  - `notes/{noteId}.fileUrl`.
- **Access**: Only through parent lesson or note.
- **Issue**: No direct access to files, no dedicated file management system.

### 4. How Does a Lesson Reach a Student?
1. **Teacher** creates/updates a lesson via `POST /api/admin/courses/:id/lessons` or `PUT /api/admin/courses/:id`.
2. **Lesson** is embedded in the course document in Firestore.
3. **Student** accesses the course via `GET /api/student/courses` or similar API.
4. **Course data** (including lessons) is returned to the student's dashboard.
5. **Student progress** is tracked in the user's `progress` field via `POST /api/student/progress`.

### 5. Why Might a Lesson Disappear?
- **Course Deletion**: If the parent course is deleted, all embedded lessons are deleted.
- **Lesson Removal**: If a lesson is removed from the `courses.lessons` array, it disappears from student view.
- **Dual-Write Failure**: If dual-write to RTDB fails, lessons may not appear in realtime features.
- **Cache Inconsistency**: If the Firestore cache is not invalidated, students may see stale data.
- **Permission Changes**: If `isFree` or `guestVisible` flags are changed, lessons may become inaccessible.

### 6. Why Might the Teacher Save Successfully but Students See Nothing?
- **Cache Inconsistency**: The Firestore cache may not be invalidated after an update.
- **Dual-Write Failure**: The lesson may be saved to Firestore but not to RTDB (if dual-write is enabled).
- **Permission Issues**: The lesson may be saved but marked as `isFree: false` or `guestVisible: false`.
- **API Response Mismatch**: The API may return success but the update may not be applied to the database.
- **Transaction Failure**: If a transaction fails silently, the lesson may not be saved.

### 7. Is There Any Mismatch Between Write Path and Read Path?
- **Yes**: 
  - **Lessons/Videos/Files**: Written as embedded objects in courses but read through course queries.
  - **Notifications**: Written to Firestore but read from RTDB (if dual-write is enabled).
  - **Attendance**: Written to RTDB but may need to be read for analytics (no Firestore backup).
  - **Chats**: Written to and read from RTDB only (no Firestore backup).

### 8. Are There Entities That Should Never Have Been Embedded?
- **Yes**: 
  - **Lessons**: Should be a subcollection of `courses` for direct access and better query capabilities.
  - **Videos**: Should be a subcollection of `lessons` for direct access and metadata management.
  - **Questions**: Should be a subcollection of `exams` or `questionBanks` for direct access and reuse.
  - **Files**: Should be a dedicated collection with metadata for better file management.

### 9. Is the Current Schema Scalable?
- **No**: 
  - **Deep Nesting**: Complex nested structures (e.g., `courses.lessons.videos`) make queries and updates difficult.
  - **Embedded Objects**: Embedded child entities (e.g., lessons, videos, questions) cannot be queried or updated directly.
  - **No Direct Access**: Many entities cannot be accessed directly, only through parent entities.
  - **Dual-Write Complexity**: Writing to both Firestore and RTDB increases inconsistency risks and operational complexity.
  - **No Versioning**: No version control for content changes makes it difficult to track and roll back updates.
  - **Orphan Records**: Many entities may become orphaned if parent entities are deleted.

---

## Final Conclusions

1. **Lessons are stored as embedded objects in courses**, making direct access and updates difficult.
2. **Videos and files are embedded in lessons**, with no dedicated file management system.
3. **A lesson reaches a student through course queries**, but may disappear if the course is deleted or cache is inconsistent.
4. **Teachers may save successfully but students see nothing** due to cache inconsistency, dual-write failures, or permission issues.
5. **There are significant mismatches between write and read paths**, especially for embedded objects and dual-write entities.
6. **Many entities should not have been embedded** (e.g., lessons, videos, questions, files) and should be moved to subcollections.
7. **The current schema is not scalable** due to deep nesting, embedded objects, and dual-write complexity.

### Recommendations (For Future Consideration)
1. **Refactor Embedded Entities**: Move lessons, videos, questions, and files to subcollections for direct access.
2. **Implement Strong Relationships**: Use foreign key constraints and cascading deletes to prevent orphan records.
3. **Standardize Storage**: Choose either Firestore or RTDB for each entity to avoid dual-write complexity.
4. **Add Versioning**: Implement version control for content changes (e.g., courses, lessons, question banks).
5. **Improve Cache Invalidation**: Ensure cache is invalidated after updates to prevent stale data.
6. **Add Direct APIs**: Provide direct APIs for child entities (e.g., lessons, videos, questions) to simplify updates.

---

**Analysis Date**: 2026-07-27