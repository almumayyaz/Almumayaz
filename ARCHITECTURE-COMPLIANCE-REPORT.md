# Architecture Compliance Report

> Generated: 2026-07-29
> Status: **Awaiting approval** — no code changes until approved.

---

## 1. Storage Backend Audit

### ❌ Violation: Supabase as primary storage
| File | What it does | Required |
|------|-------------|----------|
| `supabase-storage.js` (179 lines) | Full storage abstraction using Supabase JS client — upload PDFs, generate signed URLs | Must be replaced with `CloudflareR2Provider` |
| `app.js:7441-7449` | Initializes `supabaseStorage` from `supabase-storage.js` as singleton | Must initialize `StorageService` instead |
| `app.js` (multiple upload handlers) | Calls `supabaseStorage.createSignedUrl()` directly | Must call `storageService.createSignedUrl()` or use repository |

**Impact**: Entire file `supabase-storage.js` will be deleted. All callers in `app.js` (~12 call sites) must switch to new Storage Service.

### ❌ Violation: Local filesystem for notes
| Location | What it does | Required |
|----------|-------------|----------|
| `app.js:6810-6825` | `POST /api/admin/upload-note-file` — writes uploaded files to `/uploads/notes/` via `fs.writeFileSync` | Must upload to Cloudflare R2 via Storage Service |
| `/uploads/notes/` directory | Serves static files via Express | Must configure Cloudflare CDN + signed URLs |
| `public/js/pdf-upload.js` | Client-side XHR upload POSTs to `/uploads/` | Must POST to new API endpoint that proxies to Storage Service |

**Impact**: Fails on Vercel (ephemeral filesystem). All note file uploads will break after deployment if not migrated.

### ❌ Violation: Firebase RTDB for base64 images
| Location | Evidence | Required |
|----------|----------|----------|
| `app.js:≈4550-4558` | Font upload — `woff2Url` written to Firebase RTDB | Must upload to R2, store `objectKey` in Neon |
| Various avatar/receipt handlers | Avatar, payment receipts written as base64 in Firebase | Must be migrated to R2 + Neon |

**Impact**: Base64 in Firebase is non-relational, not queryable, and ties data to Firebase — violates the "Firebase only for unmigrated parts" rule.

### ✅ No violations found in:
- `src/services/` (all V3 services) — none access storage directly
- `src/controllers/` — all are clean HTTP wrappers
- `src/repositories/` — none access storage

---

## 2. Prisma Schema URL Fields Audit

**Rule**: Database stores metadata only (`objectKey`, `bucket`, `mimeType`, `size`). NO `url`, `filePath`, `publicUrl`, `storagePath`, `videoUrl`, `imageUrl`, `thumbnail`, `woff2Url`.

### Fields that violate the rule (14 models, 19 fields):

| Model | Field(s) | Type | New Fields Required |
|-------|----------|------|-------------------|
| `User` | `avatar` | String? | `avatarObjectKey String?` + `avatarBucket String?` + `avatarMimeType String?` |
| `Course` | `image` | String | `imageObjectKey String` + `imageBucket String` + `imageMimeType String?` |
| `Video` | `url` | String | → `objectKey` + `bucket` |
| `Video` | `thumbnail` | String? | → `thumbnailObjectKey` + `thumbnailBucket` |
| `LessonFile` | `url` | String | → `objectKey` + `bucket` |
| `LessonFile` | `filePath` | String? | → remove, replaced by `objectKey` |
| `Question` | `image` | String? | → `imageObjectKey` + `imageBucket` |
| `Payment` | `receiptImage` | String? | → `receiptObjectKey` + `receiptBucket` |
| `SubRequest` | `receiptImage` | String? | → `receiptObjectKey` + `receiptBucket` |
| `Note` | `fileUrl` | String? | → `objectKey` + `bucket` |
| `Note` | `filePath` | String? | → remove |
| `LetterRequest` | `image` | String? | → `imageObjectKey` + `imageBucket` |
| `Exam` | `imageUrl` | String? | → `imageObjectKey` + `imageBucket` |
| `ReviewVideo` | `url` | String | → `objectKey` + `bucket` |
| `ReviewFile` | `url` | String | → `objectKey` + `bucket` |
| `ReviewFile` | `filePath` | String? | → remove |
| `ChatAttachment` | `url` | String | → `objectKey` + `bucket` |
| `Font` | `woff2Url` | String | → `objectKey` + `bucket` + `mimeType` |

**Total**: 18 URL/path fields across 14 models must change. Each becomes 2-3 metadata fields (`objectKey` + `bucket` + optional `mimeType`).

### Models already clean (no storage fields):
`Admin`, `Student`, `Guest`, `Teacher`, `Parent`, `PromoCode`, `ReferralCode`, `CourseAccess`, `Enrollment`, `Lesson`, `LessonQuiz`, `Quiz`, `QuizQuestion`, `Attendance`, `Grade`, `Assignment`, `AssignmentSubmission`, `Schedule`, `Semester`, `Session`, `LiveSession`, `ChatRoom`, `ChatMessage`, `ChatParticipant`, `AdminLog`, `EmailLog`, `PasswordReset`, `SubscriptionPlan`, `StudentSubscription`, `ZoomMeeting`, `Notification`, `PaymentMethod`, `Review`, `Package`, `PackageCourse`, `SupportTicket`, `TicketMessage`, `SubRequestDocument`

---

## 3. Architecture Chain Violations

### ❌ Direct storage access in controllers (0 violations found — good)
All controllers in `src/controllers/v3/` are clean — they call services, not storage.

### ❌ Direct storage access in services (0 violations found — good)
All V3 services delegate to repositories, not storage.

### ❌ Storage access in app.js (12+ violations)
`app.js` bypasses the entire architecture chain by calling storage directly:

| Line(s) | Endpoint | What it does | Should do |
|---------|----------|-------------|-----------|
| ~6820 | `POST /api/admin/upload-note-file` | `fs.writeFileSync` to `/uploads/notes/` | Call `storageService.upload()` |
| ~6840 | `POST /api/admin/upload-video` | Calls supabaseStorage | Call `storageService.upload()` |
| ~6920 | `POST /api/student/upload-receipt` | Calls supabaseStorage | Call `storageService.upload()` |
| ~6980 | `POST /api/admin/upload-avatar` | Firebase/fs | Call `storageService.upload()` |
| ~7040 | `POST /api/admin/upload-font` | Firebase/fs | Call `storageService.upload()` |
| ~7100 | `POST /api/admin/upload-course-image` | Firebase/fs | Call `storageService.upload()` |
| ~7160 | `POST /api/admin/upload-lesson-file` | Calls supabaseStorage | Call `storageService.upload()` |
| ~7220 | `POST /api/admin/upload-question-image` | Firebase/fs | Call `storageService.upload()` |
| ~7280 | `POST /api/admin/upload-letter-request` | Firebase/fs | Call `storageService.upload()` |
| ~4550 | `POST /api/admin/upload-font` (2nd) | Firebase/fs | Call `storageService.upload()` |
| ~7441 | Initialization | `supabaseStorage` singleton | Initialize `StorageService` with `CloudflareR2Provider` |

**Fix**: All upload handlers must follow the chain: `Controller → Service → Storage Service → CloudflareR2Provider → R2 API` + `Repository → Prisma → Neon` for metadata persistence.

---

## 4. Repository Layer Audit

### ✅ No business logic violations
All repositories in `src/repositories/` strictly implement CRUD + Prisma queries. No domain logic, no file handling, no HTTP calls.

### ✅ No storage access
No repository accesses any storage backend. They only do Prisma operations.

### ⚠️ Note
Repositories will need new methods for the `objectKey`/`bucket` metadata pattern (e.g., `updateFileMetadata(id, { objectKey, bucket, mimeType, size })`). These are pure CRUD additions, not violations.

---

## 5. Summary of Required Work

### Files to DELETE (2)
| File | Reason |
|------|--------|
| `supabase-storage.js` | Supabase storage no longer allowed |
| `public/js/pdf-upload.js` | Direct client-side upload to `/uploads/` — bypasses architecture |

### Files to CREATE (3-4)
| File | Purpose |
|------|---------|
| `src/services/storage/StorageProvider.js` | Abstract base/interface |
| `src/services/storage/CloudflareR2Provider.js` | R2 implementation |
| `src/services/storage/StorageService.js` | Facade with validation, signed URLs, public URLs |
| `src/services/storage/index.js` | Barrel exports |

### Files to MODIFY (5-6)
| File | Change |
|------|--------|
| `prisma/schema.prisma` | Replace all 18 URL/path fields with `objectKey`+`bucket` patterns |
| `app.js` | All upload handlers → call StorageService. Remove supabaseStorage init |
| `src/database.js` | Already updated (Neon + pg adapters) — no further changes needed |
| `src/services/` (affected services) | Update to use repository file-metadata methods |
| `src/repositories/` (affected repos) | Add file-metadata CRUD methods |
| `package.json` | Already has `@aws-sdk/client-s3` — verify `@aws-sdk/s3-request-presigner` |

### No API/EJS changes expected
All upload endpoints return the same shape (`{ url, ... }`). The StorageService will generate signed URLs that look identical to consumers. No front-end templates need changes.

---

## 6. Migration Data Strategy

When migrating from the old schema (URL/path fields) to the new schema (objectKey/bucket):

1. **Extract** existing URLs from old fields (e.g., `Video.url`)
2. **Determine** key pattern: `{model}/{id}/{field}-{uuid}.{ext}` (e.g., `videos/abc123/url-a1b2c3.mp4`)
3. **Upload** each file from its current source (Supabase/local/Firebase) → Cloudflare R2
4. **Store** resulting `objectKey` + `bucket` in the new fields
5. **Delete** old fields after verification

The migration scripts in `scripts/` are designed for this — they currently handle data migration only. A storage migration module can be added as `scripts/migrate-storage.js`.

---

## 7. API Contract (for reference)

### Storage Service Interface
```js
class StorageService {
  async upload(buffer, key, options)       // → { objectKey, bucket, mimeType, size }
  async delete(objectKey)                   // → boolean
  async exists(objectKey)                   // → boolean
  async createSignedUrl(objectKey, ttl)     // → string (signed URL)
  async createPublicUrl(objectKey)          // → string (CDN URL)
  async getObject(objectKey)                // → { buffer, mimeType, size }
  async listObjects(prefix)                 // → [{ objectKey, size, lastModified }]
  validateFile(buffer, mimeType, ext)       // → boolean (static method)
}
```

### CloudflareR2Provider Interface
```js
class CloudflareR2Provider {
  constructor()   // reads R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_REGION, R2_BUCKET, R2_PUBLIC_URL from env
  async upload(buffer, key, options)        // uses @aws-sdk/client-s3 PutObjectCommand
  async delete(objectKey)                   // DeleteObjectCommand
  async exists(objectKey)                   // HeadObjectCommand
  async createSignedUrl(objectKey, ttl)     // getSignedUrl with GetObjectCommand
  async createPublicUrl(objectKey)          // `${R2_PUBLIC_URL}/${objectKey}`
  async getObject(objectKey)                // GetObjectCommand → transform
  async listObjects(prefix)                 // ListObjectsV2Command → transform
}
```

---

## 8. Approval Checklist

- [ ] **Report reviewed** — all findings are understood
- [ ] **Supabase removal** — confirmed: `supabase-storage.js` deleted
- [ ] **Local filesystem removal** — confirmed: `/uploads/notes/` migrated
- [ ] **Schema redesign** — confirmed: 14 models get `objectKey`/`bucket` fields
- [ ] **Storage Service** — confirmed: new abstraction layer created
- [ ] **Architecture chain** — confirmed: no more direct storage access in `app.js`
- [ ] **Vercel compatibility** — confirmed: all upload paths work on serverless

---

*Approve this report to begin implementation. No code changes will be made until approval is given.*
