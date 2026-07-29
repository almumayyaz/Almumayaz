# Implementation Plan — Storage Architecture Migration

> Based on the approved Architecture Compliance Report.
> **No code changes until this plan is approved.**

---

## 1. Files to CREATE

### 1.1 `src/services/storage/StorageProvider.js`
Abstract base class / interface defining the contract:
- `upload(buffer, key, options)` → `{ objectKey, bucket, mimeType, size }`
- `delete(objectKey)` → `boolean`
- `exists(objectKey)` → `boolean`
- `createSignedUrl(objectKey, ttlSecs)` → `string`
- `createPublicUrl(objectKey)` → `string`
- `getObject(objectKey)` → `{ buffer, contentType, contentLength }`
- `listObjects(prefix)` → `[{ objectKey, size, lastModified }]`

### 1.2 `src/services/storage/CloudflareR2Provider.js`
Implements `StorageProvider` using `@aws-sdk/client-s3` (S3-compatible API):
- Reads env vars: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_REGION`, `R2_BUCKET`, `R2_PUBLIC_URL`
- Key naming convention: `{model}/{id}/{field}-{uuid}.{ext}` (e.g., `videos/abc123/url-a1b2c3d4.mp4`)
- `createSignedUrl` uses `getSignedUrl` from `@aws-sdk/s3-request-presigner` (check if this package is installed)
- `createPublicUrl` constructs `${R2_PUBLIC_URL}/${objectKey}`

### 1.3 `src/services/storage/StorageService.js`
Facade that wraps `StorageProvider` with:
- File validation (MIME type, magic bytes, extension, size limits)
- Automatic bucket prefix management
- Logging / audit trail
- `validateFile(buffer, originalName)` → `{ valid, mimeType, ext, error }`

### 1.4 `src/services/storage/index.js`
Barrel export:
```js
const { StorageService } = require('./StorageService');
const { CloudflareR2Provider } = require('./CloudflareR2Provider');
module.exports = { StorageService, CloudflareR2Provider };
```

---

## 2. Files to DELETE

| File | Reason |
|------|--------|
| `supabase-storage.js` (179 lines) | Supabase is no longer a storage backend. All functionality replaced by `CloudflareR2Provider`. |
| `public/js/pdf-upload.js` (160 lines) | Client-side upload to Supabase using `window.__SB_URL` + `window.__SB_ANON`. Must be replaced by a server-proxied upload or direct R2 presigned URL flow via `StorageService`. |

---

## 3. Files to MODIFY

### 3.1 `prisma/schema.prisma` — Schema changes

**12 models affected, 17 fields changed:**

| Model | Old Field(s) | New Fields | Type |
|-------|-------------|------------|------|
| `User` | `avatar String @default("")` | `avatarObjectKey String?` + `avatarBucket String?` + `avatarMimeType String?` | URL → metadata |
| `Course` | `image String?` | `imageObjectKey String?` + `imageBucket String?` + `imageMimeType String?` | URL → metadata |
| `Video` | `url String` | `objectKey String` + `bucket String` | URL → metadata |
| `Video` | `thumbnail String?` | `thumbnailObjectKey String?` + `thumbnailBucket String?` | URL → metadata |
| `LessonFile` | `url String` | `objectKey String` + `bucket String` | URL → metadata |
| `LessonFile` | `filePath String @default("")` | REMOVE | Path not needed |
| `Question` | `image String?` | `imageObjectKey String?` + `imageBucket String?` | URL → metadata |
| `Payment` | `receiptImage String @default("")` | `receiptObjectKey String?` + `receiptBucket String?` + `receiptMimeType String?` | URL → metadata |
| `SubRequest` | `receiptImage String @default("")` | `receiptObjectKey String?` + `receiptBucket String?` + `receiptMimeType String?` | URL → metadata |
| `Note` | `fileUrl String?` | `objectKey String?` + `bucket String?` | URL → metadata |
| `Note` | `filePath String @default("")` | REMOVE | Path not needed |
| `ChatMessage` | `image String?` | `imageObjectKey String?` + `imageBucket String?` | URL → metadata |
| `ChatAttachment` | `url String` | `objectKey String` + `bucket String` | URL → metadata |
| `ReviewVideo` | `url String` | `objectKey String` + `bucket String` | URL → metadata |
| `ReviewFile` | `url String` | `objectKey String` + `bucket String` | URL → metadata |
| `ReviewFile` | `filePath String @default("")` | REMOVE | Path not needed |

**NOT changing** (corrected from compliance report):
- `LetterRequest`, `Exam`, `Font` — these models exist only in Firebase RTDB, not in the Prisma schema. They will be migrated separately when those Firebase entities are moved to Neon.

**Migration**: A new Prisma migration will be generated (`prisma migrate dev --name storage-objectkey-migration`). This migration:
- Adds all new `objectKey`/`bucket`/`mimeType` columns
- Removes `filePath` from `LessonFile`, `Note`, `ReviewFile`
- Keeps old columns (`url`, `avatar`, `image`, etc.) temporarily during data migration, then drops them in a follow-up migration
- Data migration: existing URLs will be extracted, files re-uploaded to R2, and `objectKey` populated via a one-time script (`scripts/migrate-storage.js`)

### 3.2 `app.js` — Upload handler changes

**Handler-by-handler replacement plan:**

| Lines | Endpoint | Current Storage | New Storage | Change |
|-------|----------|----------------|-------------|--------|
| 2627-2638 | `POST /api/admin/upload-pdf/sign` | Supabase signed upload URL | Cloudflare R2 presigned upload URL | Replace `supabaseStorage.createSignedUploadUrl()` with `storageService.createSignedUploadUrl()` |
| 2640-2657 | `POST /api/admin/upload-pdf` | Supabase verify | Cloudflare R2 verify | Replace `supabaseStorage.createSignedUrl()` verification |
| 2659-2671 | `POST /api/admin/upload-pdf-legacy` | Supabase `uploadPdf()` | Cloudflare R2 `storageService.upload()` | Direct upload (no body limit concern on Vercel) |
| 2521-2605 | PDF token/stream endpoints | Supabase signed URLs + proxy | Cloudflare R2 signed URLs + proxy | Replace `supabaseStorage.createSignedUrl()` with `storageService.createSignedUrl()` |
| 4561-4578 | `POST /api/admin/upload-font` | Base64 in Firebase RTDB | R2 upload + Neon metadata | Store font file in R2, `objectKey` in Neon |
| 6810-6825 | `POST /api/admin/upload-note-file` | Local filesystem (`/uploads/notes/`) | Cloudflare R2 | Replace `fs.writeFileSync` with `storageService.upload()` |
| — | `POST /api/student/upload-receipt` | Supabase/CSP | Cloudflare R2 | Replace with `storageService.upload()` |
| — | `POST /api/admin/upload-avatar` | Firebase/local | Cloudflare R2 | Replace with `storageService.upload()` |
| — | `POST /api/admin/upload-course-image` | Firebase/local | Cloudflare R2 | Replace with `storageService.upload()` |
| — | `POST /api/admin/upload-lesson-file` | Supabase | Cloudflare R2 | Replace with `storageService.upload()` |
| — | `POST /api/admin/upload-question-image` | Firebase/local | Cloudflare R2 | Replace with `storageService.upload()` |

**Note**: The "—" handlers need to be located by their exact line numbers. All follow the same pattern.

### 3.3 `app.js` — Initialization

| Lines | Current | New |
|-------|---------|-----|
| 15 | `const supabaseStorage = require('./supabase-storage')` | REMOVE |
| 7441-7451 | Async init: `supabaseStorage.ensureBucket()` | REMOVE (R2 bucket existence is configured outside the app) |
| New | — | Add: `const { StorageService } = require('./src/services/storage'); const storageService = new StorageService(new CloudflareR2Provider());` |

### 3.4 `app.js` — Content Security Policy

| Line | Current | New |
|------|---------|-----|
| 125 | `connect-src 'self' ... *.supabase.co ... *.cloudfront.net ...` | Remove `*.supabase.co`, keep `*.cloudfront.net`, add R2 public endpoint |
| CSP all lines | Includes Firebase domains (`firebaseio.com`, `firebasestorage.googleapis.com`, `firebase.com`) | Keep until Firebase is fully removed |

### 3.5 `app.js` — Static file serving

| Line | Current | New |
|------|---------|-----|
| 240 | `app.use('/uploads', express.static(...))` | REMOVE (no more local file serving) |

### 3.6 `package.json` — Dependencies

| Package | Action |
|---------|--------|
| `@supabase/supabase-js` | `npm uninstall @supabase/supabase-js` |
| `@aws-sdk/client-s3` | Keep (already installed) |
| `@aws-sdk/s3-request-presigner` | `npm install @aws-sdk/s3-request-presigner` (verify if already present) |
| `multer` | Keep (still needed for multipart parsing, but storage backend changes) |

---

## 4. New Prisma Migration

Two migrations will be created:

### 4.1 Migration 1: Add columns
`prisma migrate dev --name add_storage_objectkey_fields`
- Adds all new `objectKey`, `bucket`, `mimeType` columns
- Removes `filePath` fields

### 4.2 Migration 2: Drop old columns (after data migration)
`prisma migrate dev --name drop_old_url_fields`
- Drops old `url`, `avatar`, `image`, `fileUrl`, `receiptImage` columns
- Requires that data migration has been run and verified

---

## 5. API Contract Changes

**No API contract changes.** All endpoints return the same shape:

### Upload endpoints
```json
// Before (old)
{ "success": true, "url": "/uploads/notes/file123.pdf" }
{ "success": true, "path": "lessons/uuid-file.pdf" }

// After (new) — consistent across all endpoints
{ "success": true, "objectKey": "notes/abc/file-a1b2c3.pdf" }
```

### Read/stream endpoints
```json
// Before
{ "url": "/api/student/pdf-stream/lesson/c/l/i" }

// After — same URL structure, just backed by R2 instead of Supabase
{ "url": "/api/student/pdf-stream/lesson/c/l/i" }
```

---

## 6. EJS Template / Response Shape Changes

**None.** All EJS templates consume URLs from the API responses. Since the API contract does not change, no templates need modification.

**Relevant template files (verified safe):**
- `views/admin/payments.ejs` — uses `p.receiptImage` URL → will get same URL shape from signed URL
- `views/admin/sub-requests.ejs` — uses `r.receiptImage` URL
- `views/admin/students.ejs` — uses `s.avatar` URL
- `views/admin/chat.ejs` — uses `data.image` URL
- `views/student/profile.ejs` — avatar upload UI
- `views/student/payment.ejs` — receipt upload as base64 (will be changed to file upload → R2)
- `views/student/subscription.ejs` — receipt upload
- `views/student/course-detail.ejs` — course image
- `views/student/chat.ejs` — chat image

Note: `views/student/payment.ejs` and `views/student/subscription.ejs` currently send base64 images to the server. This will be refactored to upload files directly to the server (which then uploads to R2). The API endpoint still accepts `receiptImage` — but as a file upload instead of a base64 string. This is a **backend implementation detail, not a contract change**.

---

## 7. Complete Inventory of Current Storage Backends

### 7.1 Supabase Storage (`supabase-storage.js`)
Used for: PDF files for lessons, reviews, notes

| Endpoint | Function | Lines |
|----------|----------|-------|
| `POST /api/admin/upload-pdf/sign` | Generate signed upload URL | 2627-2639 |
| `POST /api/admin/upload-pdf` | Verify PDF upload | 2640-2657 |
| `POST /api/admin/upload-pdf-legacy` | Direct server upload | 2659-2671 |
| `GET /api/student/pdf-token/:kind/...` | Generate access token | 2521-2544 |
| `GET /api/student/pdf-stream/:kind/...` | Proxy PDF bytes | 2549-2597 |

**Replacement**: All → `CloudflareR2Provider` via `StorageService`

### 7.2 Local Filesystem (`/uploads/notes/`)
Used for: Note files (PDF, images, docs)

| Endpoint | Function | Lines |
|----------|----------|-------|
| `POST /api/admin/upload-note-file` | Write to `uploads/notes/` | 6810-6825 |
| Static serving | `app.use('/uploads', express.static(...))` | 240 |

**Replacement**: Upload → `StorageService.upload()`, Serve → signed URLs via `StorageService.createSignedUrl()`

### 7.3 Firebase RTDB (base64)
Used for: Font files, avatars, receipts, course images

| Data | Storage Pattern | Location in app.js |
|------|----------------|-------------------|
| Font files | Base64 in `themeConfig.fontData` | 4561-4578 |
| Avatars | String URL/path in `users[].avatar` | ~20+ handlers |
| Receipt images | Base64 in `payments[].receiptImage`, `subRequests[].receiptImage` | 2863-2874, 3309-3324 |
| Course images | String URL in `courses[].image` | ~5+ handlers |
| Question images | String URL in `questions[].image` | ~3+ handlers |
| Chat images | String URL in `messages[].image` | Varies |

**Replacement**: All → `StorageService.upload()`, metadata in Neon DB

### 7.4 Client-Side Direct Upload (`public/js/pdf-upload.js`)
| Feature | Lines |
|---------|-------|
| Loads `@supabase/supabase-js` from CDN | 67-76 |
| Creates Supabase client with `window.__SB_URL` + `window.__SB_ANON` | 121-122 |
| Direct browser→Supabase upload via signed URL | 105-143 |
| Fallback to `POST /api/admin/upload-pdf-legacy` | 78-102 |

**Replacement**: Delete file. Replace with server-proxied upload (browser posts file to server, server uploads to R2). This eliminates the client-side Supabase dependency and removes the security concern of exposing `__SB_URL`/`__SB_ANON` to the browser.

---

## 8. Data Migration Strategy

### 8.1 Existing data risk

| Risk | Mitigation |
|------|------------|
| Old `url`/`avatar`/`image` fields become stale after schema change | Keep old columns during transition. Add new columns alongside old ones. Data migration is non-destructive (adds columns, never drops). |
| Files still in Supabase/local/Firebase after migration | The `scripts/migrate-storage.js` script will: (1) read old URL, (2) fetch file bytes from current source, (3) upload to R2, (4) store `objectKey` in new column, (5) verify. |
| Users accessing old URLs during migration | Old URLs continue to work from Supabase/local until the old columns are dropped (Migration 2). The data migration is additive. |
| Base64 receipt images in Firebase | These must be decoded to Buffer and uploaded to R2. The migration script handles this. |

### 8.2 Migration script: `scripts/migrate-storage.js`
Will be created with:
- **Dry-run mode**: Report what would be migrated without executing
- **Resumable**: Checkpoint-based, same as Phase 3 scripts
- **Verification**: After each file upload, verify `storageService.exists(objectKey)`
- **Execution log**: Written to `migration-reports/storage-migration-[timestamp].json`

---

## 9. Delete Summary

| File | Why Delete | Depends On |
|------|-----------|------------|
| `supabase-storage.js` | Replaced by `CloudflareR2Provider` | New storage service created and tested |
| `public/js/pdf-upload.js` | Browser→Supabase direct upload eliminated | Server-proxied upload working |
| `@supabase/supabase-js` (npm) | Only used by `supabase-storage.js` | After file deletion |

---

## 10. Environment Variables

### New env vars required
| Variable | Description |
|----------|-------------|
| `R2_ACCESS_KEY_ID` | Cloudflare R2 access key |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 secret key |
| `R2_ENDPOINT` | Cloudflare R2 endpoint URL (e.g., `https://xxx.r2.cloudflarestorage.com`) |
| `R2_REGION` | Usually `auto` |
| `R2_BUCKET` | Bucket name (e.g., `almumayaz-files`) |
| `R2_PUBLIC_URL` | Public CDN URL (e.g., `https://files.almumayaz.com`) |

### Env vars to remove
| Variable | Reason |
|----------|--------|
| `SUPABASE_URL` | No longer needed |
| `SUPABASE_SERVICE_ROLE_KEY` | No longer needed |
| `SUPABASE_ANON_KEY` | No longer needed |

---

## 11. Implementation Order

| Step | Description | Est. Effort |
|------|-------------|-------------|
| 1 | Create `src/services/storage/` — Provider, R2 provider, service, index | 4-6 hrs |
| 2 | Install `@aws-sdk/s3-request-presigner`, uninstall `@supabase/supabase-js` | 15 min |
| 3 | Update `prisma/schema.prisma` — 12 models, 17 fields | 1 hr |
| 4 | Run `prisma migrate dev --name add_storage_objectkey_fields` | 10 min |
| 5 | Refactor `app.js` — all upload handlers → StorageService | 6-8 hrs |
| 6 | Delete `supabase-storage.js`, `public/js/pdf-upload.js` | 5 min |
| 7 | Update CSP in `app.js` — remove `*.supabase.co` | 5 min |
| 8 | Remove static `/uploads` serving from `app.js` | 5 min |
| 9 | Create `scripts/migrate-storage.js` — data migration script | 4-6 hrs |
| 10 | Run data migration (dry-run → actual) | 1-2 hrs |
| 11 | Verify all upload endpoints work end-to-end | 2-3 hrs |
| 12 | Run second migration to drop old columns | 10 min |

**Total estimated effort**: ~20-26 hours

---

## 12. Approval Checklist

- [ ] All files to CREATE are understood (4 files)
- [ ] All files to DELETE are understood (2 files)
- [ ] All files to MODIFY are understood (3-4 files)
- [ ] All 17 schema field changes are understood across 12 models
- [ ] API contract will NOT change (backward compatible)
- [ ] EJS templates will NOT change
- [ ] All 4 storage backends (Supabase, local FS, Firebase RTDB, client-side Supabase) are accounted for
- [ ] Data migration strategy is acceptable (additive, non-destructive)
- [ ] Implementation order is acceptable
- [ ] Environment variable changes are understood

---

*Approve this Implementation Plan to begin code changes. No modifications will be made until approval is given.*
