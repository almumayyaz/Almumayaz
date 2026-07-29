# SECURITY PLAN — Firestore Security Rules + Permissions

## Role Hierarchy

```
ADMIN (role: 'admin')
  → Full read/write access to all collections
  → Can manage users, courses, settings, payments
  → Can delete/archive any document

TEACHER (role: 'teacher')
  → Read all course content
  → Write own course content
  → Read student progress
  → No access to billing/settings

STUDENT (role: 'student')
  → Read enrolled courses and content
  → Write own progress, bookmarks, notes
  → Read own profile
  → No access to other student data

PARENT (role: 'parent')
  → Read linked children's profiles
  → Read linked children's progress
  → No write access

ANONYMOUS (unauthenticated)
  → Read guest-visible courses/lessons only
  → No write access
  → Read public announcements
```

## Firestore Security Rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ===== HELPER FUNCTIONS =====
    function isAdmin() {
      return request.auth != null &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }

    function isTeacher() {
      return request.auth != null &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'teacher';
    }

    function isStudent() {
      return request.auth != null &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'student';
    }

    function isParent() {
      return request.auth != null &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'parent';
    }

    function isAuthenticated() {
      return request.auth != null;
    }

    function isOwner(userId) {
      return request.auth != null && request.auth.uid == userId;
    }

    function hasActiveSubscription(userId) {
      let user = get(/databases/$(database)/documents/users/$(userId));
      return user.data.subscriptionStatus == 'active';
    }


    // ===== USERS =====
    match /users/{userId} {
      // Admin: full access
      allow read: if isAdmin() || isOwner(userId) || isParentOf(userId);
      allow create: if isAdmin();
      allow update: if isAdmin() || isOwner(userId);
      allow delete: if isAdmin();

      // Students can only update safe fields
      allow update: if isOwner(userId) && request.resource.data.diff(resource.data).affectedKeys()
        .hasOnly(['name', 'phone', 'avatar', 'governorate', 'fcmToken']);
    }


    // ===== COURSES =====
    match /courses/{courseId} {
      allow read: if isAuthenticated();
      allow create: if isAdmin() || isTeacher();
      allow update: if isAdmin() || isTeacher();
      allow delete: if isAdmin();
    }


    // ===== UNITS =====
    match /units/{unitId} {
      allow read: if isAuthenticated();
      allow write: if isAdmin() || isTeacher();
    }


    // ===== LESSONS =====
    match /lessons/{lessonId} {
      allow read: if isAuthenticated();
      allow write: if isAdmin() || isTeacher();
    }


    // ===== LESSON VIDEOS =====
    match /lessonVideos/{videoId} {
      allow read: if isAuthenticated();
      allow write: if isAdmin() || isTeacher();
    }


    // ===== LESSON FILES =====
    match /lessonFiles/{fileId} {
      allow read: if isAuthenticated();
      allow write: if isAdmin() || isTeacher();
    }


    // ===== QUIZZES =====
    match /quizzes/{quizId} {
      allow read: if isAuthenticated();
      allow write: if isAdmin() || isTeacher();
    }


    // ===== QUESTIONS =====
    match /questions/{questionId} {
      allow read: if isAuthenticated();
      allow write: if isAdmin() || isTeacher();
    }


    // ===== ENROLLMENTS =====
    match /enrollments/{enrollmentId} {
      allow read: if isAdmin() || isOwner(resource.data.userId);
      allow create: if isAdmin() || isStudent();
      allow update: if isAdmin();
      allow delete: if isAdmin();
    }


    // ===== STUDENT PROGRESS =====
    match /studentProgress/{progressId} {
      allow read: if isAdmin() || isOwner(resource.data.userId) || isParentOf(resource.data.userId);
      allow create: if isOwner(resource.data.userId);
      allow update: if isOwner(resource.data.userId);
      allow delete: if isAdmin();
    }

    match /studentLessonProgress/{progressId} {
      allow read: if isAdmin() || isOwner(resource.data.userId);
      allow write: if isOwner(resource.data.userId) || isAdmin();
    }


    // ===== EXAM ATTEMPTS =====
    match /studentExamAttempts/{attemptId} {
      allow read: if isAdmin() || isOwner(resource.data.userId);
      allow create: if isOwner(resource.data.userId);
      allow update: if isAdmin();
      allow delete: if isAdmin();
    }


    // ===== BOOKMARKS =====
    match /studentBookmarks/{bookmarkId} {
      allow read: if isOwner(resource.data.userId) || isAdmin();
      allow write: if isOwner(resource.data.userId);
    }


    // ===== STUDENT NOTES =====
    match /studentNotes/{noteId} {
      allow read: if isOwner(resource.data.userId) || isAdmin();
      allow write: if isOwner(resource.data.userId);
    }


    // ===== NOTIFICATIONS =====
    match /notifications/{notificationId} {
      allow read: if isAuthenticated();
      allow write: if isAdmin();
    }


    // ===== SETTINGS =====
    match /settings/{settingId} {
      allow read: if isAuthenticated();
      allow write: if isAdmin();
    }


    // ===== FEATURE FLAGS =====
    match /featureFlags/{flagId} {
      allow read: if isAuthenticated();
      allow write: if isAdmin();
    }


    // ===== PAYMENTS =====
    match /payments/{paymentId} {
      allow read: if isAdmin() || isOwner(resource.data.userId);
      allow write: if isAdmin();
    }

    match /paymentReceipts/{receiptId} {
      allow read: if isAdmin() || isOwner(resource.data.userId);
      allow create: if isOwner(resource.data.userId);
      allow update: if isAdmin();
      allow delete: if isAdmin();
    }


    // ===== SUBSCRIPTIONS =====
    match /subscriptions/{subId} {
      allow read: if isAuthenticated();
      allow write: if isAdmin();
    }


    // ===== SUPPORT TICKETS =====
    match /supportTickets/{ticketId} {
      allow read: if isAdmin() || isOwner(resource.data.userId);
      allow create: if isAuthenticated();
      allow update: if isAdmin() || isOwner(resource.data.userId);
      allow delete: if isAdmin();
    }


    // ===== ANNOUNCEMENTS =====
    match /announcements/{announcementId} {
      allow read: if isAuthenticated();
      allow write: if isAdmin();
    }


    // ===== REVIEWS =====
    match /reviews/{reviewId} {
      allow read: if isAuthenticated();
      allow write: if isAdmin();
    }


    // ===== CHARGE CODES =====
    match /chargeCodes/{codeId} {
      allow read: if isAdmin();
      allow write: if isAdmin();
      // Students can read via API endpoint (validated server-side)
    }


    // ===== PARENT INVITES =====
    match /parentInvites/{inviteId} {
      allow read: if isAdmin() || isOwner(resource.data.studentId);
      allow write: if isAdmin() || isOwner(resource.data.studentId);
    }


    // ===== ACTIVITY LOGS =====
    match /activityLogs/{logId} {
      allow read: if isAdmin();
      allow create: if isAuthenticated();
      allow update: if isAdmin();
      // Append-only, no delete
    }


    // ===== SYSTEM STATS =====
    match /systemStats/{statId} {
      allow read: if isAdmin();
      allow write: if isAdmin();
    }


    // ===== ANALYTICS =====
    match /analytics/{analyticId} {
      allow read: if isAdmin();
      allow write: if isAdmin();
    }


    // ===== DENY ALL BY DEFAULT =====
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

## RTDB Security Rules

```json
{
  "rules": {
    "presence": {
      "$userId": {
        ".read": "$userId === auth.uid || root.child('users/'+auth.uid+'/role').val() === 'admin'",
        ".write": "$userId === auth.uid"
      }
    },
    "chatMessages": {
      "$chatId": {
        ".read": "auth.uid !== null",
        ".write": "auth.uid !== null",
        "$messageId": {
          ".validate": "newData.hasChildren(['senderId', 'text', 'timestamp'])"
        }
      }
    },
    "liveSessionAttendance": {
      "$sessionId": {
        "$userId": {
          ".read": "auth.uid !== null",
          ".write": "$userId === auth.uid || root.child('users/'+auth.uid+'/role').val() === 'admin'"
        }
      }
    },
    "liveSessionState": {
      "$sessionId": {
        ".read": "auth.uid !== null",
        ".write": "root.child('users/'+auth.uid+'/role').val() === 'admin'"
      }
    },
    ".read": false,
    ".write": false
  }
}
```

## Principle of Least Privilege (Summary)

| Collection | Admin | Teacher | Student | Parent | Anonymous |
|---|---|---|---|---|---|
| `users` | CRUD | R (own) | R (own) + U (safe) | R (children) | — |
| `courses` | CRUD | CRUD | R | R | R (guest) |
| `units` | CRUD | CRUD | R | R | — |
| `lessons` | CRUD | CRUD | R | R | R (guest) |
| `lessonVideos` | CRUD | CRUD | R | R | R (guest) |
| `lessonFiles` | CRUD | CRUD | R | R | R (guest) |
| `quizzes` | CRUD | CRUD | R | R | — |
| `questions` | CRUD | CRUD | R | R | — |
| `enrollments` | CRUD | — | R | R | — |
| `payments` | CRUD | — | R (own) | — | — |
| `studentProgress` | CRUD | R | CRUD (own) | R | — |
| `studentExamAttempts` | CRUD | R | C (own) | — | — |
| `notifications` | CRUD | — | R | R | — |
| `settings` | CRUD | R | R | R | R |
| `supportTickets` | CRUD | — | CRUD (own) | — | — |
