# Storage Architecture Audit — Pre-Step 3 Report

> Read-only. No files were modified.
> Generated: 2026-07-29

---

## Summary

| Metric | Count |
|--------|-------|
| **Total storage points found** | **9** (8 active + 1 dead model) |
| **Files expected to modify in Step 3** | **2** (see section below) |
| **Storage backends currently in use** | 3 (Firebase RTDB, Supabase Storage, Local filesystem) |
| **Planned target** | 1 (Cloudflare R2 via StorageService) |

---

## Complete Storage Point Analysis

---

### Feature 1: User Avatars

| Field | Detail |
|-------|--------|
| **Current Storage** | Firebase RTDB — `users[].avatar` as base64 data URI string |
| **Current Upload Flow** | Client-side: `FileReader.readAsDataURL()` → canvas resize to JPEG 0.8 quality → `PUT /api/student/profile` with `{ avatar: base64 }`. Server: `writeData('users', users)` with whitelisted `avatar` field. No multer, no file upload. |
| **Current Delete Flow** | No dedicated delete. Overwritten by setting empty string via same PUT endpoint. |
| **Current Read Flow** | Avatar base64 is in the user object. EJS renders `<img src="<%= user.avatar %>">` directly. |
| **Current Database Fields** | `User.avatar String @default("")` in Prisma. `users[].avatar` in Firebase RTDB. |
| **Current URL Format** | `data:image/jpeg;base64,/9j/4AAQ...` (base64 data URI, up to ~500KB) |
| **Used By** | `views/student/profile.ejs` (upload), `views/partials/header.ejs`, `views/partials/student-sidebar.ejs`, `views/partials/admin-sidebar.ejs`, `views/admin/students.ejs`, `views/admin/settings.ejs` (display) |
| **Dependencies** | `app.js:2942-2968` (PUT handler), `src/services/user.service.js:54` (me() returns avatar), `zoom-oauth.js:284` (stores Zoom URL) |
| **Risk Level** | **Medium** — base64 in RTDB bloats DB, slow avatar loads |
| **Migration Difficulty** | **Easy** — one field, one endpoint, simple replacement |
| **Recommended Integration** | Upload via `StorageService.upload()` → store `objectKey` → generate signed URL on read |

---

### Feature 2: Chat Images

| Field | Detail |
|-------|--------|
| **Current Storage** | Firebase RTDB (`chats/{id}/messages/{id}.image`) as base64 data URI. Also PostgreSQL `ChatMessage.image` as base64 in new architecture. |
| **Current Upload Flow** | Client: `FileReader.readAsDataURL()` → XHR `POST /api/student/chat/send` or `/api/admin/chat/:id/send` with `{ text, image: base64 }`. No multer — image sent inline in JSON body. |
| **Current Delete Flow** | No dedicated delete. Image is part of message, message can't be deleted individually. |
| **Current Read Flow** | Firebase listener: `fbRead('chats/'+cid+'/messages')` → renders `<img>` from base64. New: `ChatMessage.image` string from Prisma. |
| **Current Database Fields** | Firebase: `messages[].image` (base64). Prisma: `ChatMessage.image String?` |
| **Current URL Format** | `data:image/png;base64,iVBOR...` (base64 data URI, up to ~5MB) |
| **Used By** | `views/student/chat.ejs` (upload + display), `views/admin/chat.ejs` (upload + display), `app.js:3517-3524` (student send), `app.js:3557-3568` (admin send) |
| **Dependencies** | `src/services/chat.service.js:33` (new arch), `src/controllers/chat.controller.js:16-21` |
| **Risk Level** | **High** — base64 images in real-time chat cause massive bandwidth usage on RTDB. Each image refresh re-downloads all base64 data. |
| **Migration Difficulty** | **Medium** — requires changing upload flow from inline JSON to multipart file upload |
| **Recommended Integration** | Add multer to chat send routes → `StorageService.upload()` → store `objectKey` in message → signed URL on read |

---

### Feature 3: Payment Receipts

| Field | Detail |
|-------|--------|
| **Current Storage** | Firebase RTDB — `payments[].receiptImage` as base64 data URI |
| **Current Upload Flow** | Client: `FileReader.readAsDataURL()` → `POST /api/student/submit-payment` with `{ receiptImage: base64 }`. Server validates with `validateReceiptImage()` (magic byte check), stores in payments array. |
| **Current Delete Flow** | No delete. Payment records are permanent. |
| **Current Read Flow** | Admin page: `<img src="<%= p.receiptImage %>">` directly from payment record. No signed URLs. |
| **Current Database Fields** | `Payment.receiptImage String @default("")` in Prisma. `payments[].receiptImage` in Firebase RTDB. |
| **Current URL Format** | `data:image/jpeg;base64,/9j/...` (base64 data URI, validated < 3MB) |
| **Used By** | `views/student/payment.ejs` (upload), `views/admin/payments.ejs` (display), `app.js:2861-2885` (submit handler) |
| **Dependencies** | `app.js:86-107` (validateReceiptImage), `src/services/user.service.js:71-78` (new arch submitPayment) |
| **Risk Level** | **Medium** — image stored twice (base64 in RTDB + can't be served via CDN) |
| **Migration Difficulty** | **Easy** — one field, one endpoint, similar to avatar |
| **Recommended Integration** | Change client to upload file → `StorageService.upload()` → store `objectKey` → signed URL on read |

---

### Feature 4: Subscription Request Receipts

| Field | Detail |
|-------|--------|
| **Current Storage** | Firebase Firestore — `subRequests/{id}.receiptImage` as base64 data URI |
| **Current Upload Flow** | Client: `FileReader.readAsDataURL()` → `POST /api/student/subscribe` with `{ receiptImage: base64 }`. Server validates, writes to Firestore. |
| **Current Delete Flow** | No delete. Status changes (approved/rejected) but image persists. |
| **Current Read Flow** | Admin page: `<img id="receiptModalImg">` with zoom/pan. Loaded from `subRequests[].receiptImage` base64. |
| **Current Database Fields** | `SubRequest.receiptImage String @default("")` in Prisma. `subRequests/{id}.receiptImage` in Firestore. |
| **Current URL Format** | `data:image/...;base64,...` |
| **Used By** | `views/student/subscription.ejs` (upload), `views/admin/sub-requests.ejs` (display with zoom/pan), `app.js:3307-3333` (subscribe handler) |
| **Dependencies** | `app.js:86-107` (validateReceiptImage) |
| **Risk Level** | **Medium** — same as payment receipts, Firestore pricing per-document-read |
| **Migration Difficulty** | **Easy** — identical to payment receipts |
| **Recommended Integration** | Upload to R2 → store objectKey → signed URL for admin viewing |

---

### Feature 5: Lesson PDF Files

| Field | Detail |
|-------|--------|
| **Current Storage** | Supabase Storage — private bucket `books` with path `lessons/{uuid}-{name}.pdf` |
| **Current Upload Flow** | **Two paths**: (A) Browser→Supabase direct: `POST /api/admin/upload-pdf/sign` gets signed URL → browser uploads directly via Supabase JS SDK. (B) Server proxy: `POST /api/admin/upload-pdf-legacy` → multer → `supabaseStorage.uploadPdf()`. |
| **Current Delete Flow** | **No delete endpoint exists.** When lesson is deleted, the PDF stays orphaned in Supabase bucket. `supabaseStorage.removePdf()` exists but is never called. |
| **Current Read Flow** | `GET /api/student/pdf-token/lesson/...` → same-origin stream URL. `GET /api/student/pdf-stream/lesson/...` → server fetches Supabase signed URL and pipes bytes. No direct client→Supabase access. |
| **Current Database Fields** | Firebase: `lessons[].pdfFiles[].path` (Supabase key). Prisma: `LessonFile.url`, `LessonFile.filePath`, `LessonFile.type`, `LessonFile.size`. Legacy: `Lesson.pdfFiles Json`. |
| **Current URL Format** | `lessons/{uuid}-{sanitized-name}.pdf` (Supabase object key, not a URL) |
| **Used By** | `app.js:2627-2671` (upload routes), `app.js:2521-2605` (token/stream routes), `public/js/pdf-upload.js` (client upload lib), `views/admin/courses.ejs` (upload UI), `views/student/lesson.ejs` (view UI), `views/student/pdfjs-view.ejs` (PDF viewer) |
| **Dependencies** | `supabase-storage.js` (whole file), `public/js/pdf-upload.js` (client lib), `public/js/pdfjs-viewer.js` (viewer), `public/js/pdf.min.js` + `pdf.worker.min.js` |
| **Risk Level** | **High** — most complex integration. Two upload flows, signed URL proxying, multiple auth layers, Range header passthrough for large PDFs. |
| **Migration Difficulty** | **Hard** — requires changing upload flow, token generation, stream proxy |
| **Recommended Integration** | Phase 1: Replace `supabaseStorage.createSignedUrl()` with `StorageService.createSignedUrl()` in stream proxy. Phase 2: Replace upload endpoints. Phase 3: Remove `supabase-storage.js`. |

---

### Feature 6: Review PDF Files

| Field | Detail |
|-------|--------|
| **Current Storage** | Supabase Storage — same `books` bucket, path `reviews/{uuid}-{name}.pdf` |
| **Current Upload Flow** | Identical to Lesson PDFs — same `uploadPdfFile(file, 'reviews')` call from `views/admin/reviews.ejs`, same `POST /api/admin/upload-pdf/*` routes. |
| **Current Delete Flow** | **No delete.** Same orphaned file problem as lessons. |
| **Current Read Flow** | `GET /api/student/pdf-token/review/:id/:i` → `GET /api/student/pdf-stream/review/:id/:i`. Same pattern as lessons. |
| **Current Database Fields** | Firebase: `reviews[].pdfFiles[].path`. Prisma: `ReviewFile.url`, `ReviewFile.filePath`. Legacy: `Review.pdfFiles Json`. |
| **Current URL Format** | `reviews/{uuid}-{name}.pdf` |
| **Used By** | Same infra as Lesson PDFs. `views/admin/reviews.ejs`, `views/student/review-detail.ejs` |
| **Dependencies** | Same as Lesson PDFs |
| **Risk Level** | **High** — shares all infrastructure with Lesson PDFs |
| **Migration Difficulty** | **Hard** — same as Lesson PDFs |
| **Recommended Integration** | Migrate alongside Lesson PDFs in the same sub-step |

---

### Feature 7: Note Files (Dual Storage)

| Field | Detail |
|-------|--------|
| **Current Storage** | **Two backends**: (A) Supabase Storage `books` bucket via `uploadPdfFile()`. (B) Local filesystem `uploads/notes/` via `POST /api/admin/upload-note-file`. |
| **Current Upload Flow** | **Path A** (Supabase): Admin UI calls `uploadPdfFile(file, 'notes')` → Supabase signed URL flow. **Path B** (Local): `POST /api/admin/upload-note-file` → multer → `fs.writeFileSync()` to `/uploads/notes/note-{timestamp}.{ext}`. |
| **Current Delete Flow** | `DELETE /api/admin/notes/:id` deletes note from Firebase array but **does NOT call `supabaseStorage.removePdf()`** — orphans the file. Local filesystem note files are never deleted. |
| **Current Read Flow** | Supabase path: Same PDF stream proxy (`/api/student/pdf-stream/note/:id`). Local path: Direct `/uploads/notes/{filename}` served via `express.static('/uploads')`. External `fileUrl`: Direct browser access. |
| **Current Database Fields** | `Note.filePath String @default("")` (Supabase key or local path), `Note.fileUrl String?` (external URL) in Prisma. |
| **Current URL Format** | Supabase: `notes/{uuid}-{name}.pdf`. Local: `/uploads/notes/note-{timestamp}.{ext}`. External: Any URL. |
| **Used By** | `app.js:6810-6825` (local upload endpoint), `app.js:240` (static serving), `views/admin/notes.ejs` (admin UI), `views/student/notes.ejs` (student view), `views/student/pdfjs-view.ejs` (PDF viewer) |
| **Dependencies** | `supabase-storage.js`, `public/js/pdf-upload.js`, local `uploads/` directory |
| **Risk Level** | **Critical** — local filesystem path will **fail on Vercel** (ephemeral FS). This is the #1 priority to fix. |
| **Migration Difficulty** | **Medium** — need to eliminate local path, consolidate to single R2 path |
| **Recommended Integration** | Step 1: Replace local `fs.writeFileSync` path with `StorageService.upload()`. Step 2: Remove local path entirely. |

---

### Feature 8: Font Files

| Field | Detail |
|-------|--------|
| **Current Storage** | Firebase RTDB — `themeConfig.fontData.data` as base64 string |
| **Current Upload Flow** | `POST /api/admin/upload-font` → multer `fontUpload.single('fontFile')` → `req.file.buffer.toString('base64')` stored in `themeConfig.fontData`. Max 3MB. |
| **Current Delete Flow** | `POST /api/admin/remove-font` — deletes `themeConfig.fontData`. |
| **Current Read Flow** | `themeConfig.fontData` is read into memory and served via CSS injection (`getThemeCss()`). The base64 is embedded in the CSS as `@font-face { src: url(data:font/woff2;base64,...) }`. |
| **Current Database Fields** | Firebase: `themeConfig.fontData.data` (base64), `themeConfig.fontData.name`, `themeConfig.fontData.format`, etc. No Prisma model — `Font` model is Firebase-only. |
| **Current URL Format** | `data:font/woff2;base64,d09GMg...` (embedded in CSS, not a URL) |
| **Used By** | `views/dev/panel.ejs` (upload UI, line 539-557), `app.js:4561-4578` (upload handler), `app.js:4581-4589` (remove handler), `getThemeCss()` CSS generation |
| **Dependencies** | `firebase-admin.js` (readData/writeData for themeConfig), CACHEABLE includes themeConfig |
| **Risk Level** | **Low-Medium** — 3MB base64 in RTDB is not ideal but font files are rarely changed |
| **Migration Difficulty** | **Easy** — single endpoint, single field, font uploads are rare |
| **Recommended Integration** | Upload to R2 → `StorageService.createPublicUrl()` → reference as `url()` in CSS instead of base64 |

---

### Feature 9: Chat Attachments (Dead Model)

| Field | Detail |
|-------|--------|
| **Current Storage** | PostgreSQL `ChatAttachment` table — **never populated**. Model exists but no code writes to it. |
| **Current Upload Flow** | **None.** No upload endpoint, no multer, no client code. The model is a dead schema artifact. |
| **Current Delete Flow** | None (nothing to delete). |
| **Current Read Flow** | None. |
| **Current Database Fields** | `ChatAttachment.url` (String), `ChatAttachment.type` (String), `ChatAttachment.name` (String), `ChatAttachment.size` (Int?), `ChatAttachment.metadata` (Json?) |
| **Current URL Format** | N/A — never written. |
| **Used By** | No one. The model exists in schema.prisma lines 628-639. |
| **Dependencies** | None. |
| **Risk Level** | **None** — not in use. Can be populated or removed later. |
| **Migration Difficulty** | **Easy** — either remove the model or implement chat file upload using StorageService |
| **Recommended Integration** | During chat migration: add multer to chat routes → upload to R2 → populate ChatAttachment model |

---

## Final Summary Table

| # | Feature | Current Backend | Target Backend | Needs DB Change | Needs API Change | Risk |
|---|---------|----------------|----------------|-----------------|-----------------|------|
| 1 | User Avatars | Firebase RTDB (base64) | Cloudflare R2 | Yes (User.avatar → objectKey) | No (same shape) | Medium |
| 2 | Chat Images | Firebase RTDB/PostgreSQL (base64) | Cloudflare R2 | Yes (ChatMessage.image → objectKey) | Yes (change to multipart upload) | High |
| 3 | Payment Receipts | Firebase RTDB (base64) | Cloudflare R2 | Yes (Payment.receiptImage → objectKey) | No (same shape) | Medium |
| 4 | Sub Request Receipts | Firebase Firestore (base64) | Cloudflare R2 | Yes (SubRequest.receiptImage → objectKey) | No (same shape) | Medium |
| 5 | Lesson PDFs | Supabase Storage | Cloudflare R2 | Yes (LessonFile.url → objectKey) | No (stream proxies unchanged) | High |
| 6 | Review PDFs | Supabase Storage | Cloudflare R2 | Yes (ReviewFile.url → objectKey) | No (stream proxies unchanged) | High |
| 7 | Note Files | Supabase + Local FS | Cloudflare R2 | Yes (Note.fileUrl/Path → objectKey) | No | Critical |
| 8 | Font Files | Firebase RTDB (base64) | Cloudflare R2 | No (Font model not in Prisma) | Yes (change CSS generation) | Low-Med |
| 9 | Chat Attachments | (dead model, never used) | Cloudflare R2 | No change needed | New implementation | None |

---

## Files Affected in Step 3

Step 3 scope (as defined in the Implementation Plan) is to **wire StorageFactory into the app initialization** — no feature integration yet.

### Files to MODIFY in Step 3

| # | File | Change | Reason |
|---|------|--------|--------|
| 1 | `app.js` (~line 7441) | Replace Supabase IIFE init with `StorageFactory.getStorageService()` init | The app currently initializes `supabaseStorage.ensureBucket()` at startup. This must be replaced by the factory init. |
| 2 | `.env` / `vercel.json` (if applicable) | Add `STORAGE_PROVIDER=legacy` env var | Feature flag must be explicitly set so the factory returns the correct provider. Default is `legacy` already, but explicit is safer. |

### Files to CREATE in Step 3

None. The full storage layer already exists from Steps 1-2.

### Files NOT changed in Step 3 (verified safe)

These files are explicitly excluded from Step 3:

| File | Reason excluded |
|------|----------------|
| `supabase-storage.js` | Not yet deleted — LegacyStorageAdapter still wraps it |
| `public/js/pdf-upload.js` | Not yet deleted — browser→Supabase upload still active |
| `prisma/schema.prisma` | No schema changes in Step 3 |
| `src/services/*` (all) | No service changes in Step 3 |
| `src/controllers/*` (all) | No controller changes in Step 3 |
| `src/repositories/*` (all) | No repository changes in Step 3 |
| All EJS templates | No template changes in Step 3 |

---

## Step 3 Execution Plan — Sub-steps

### Sub-step 3.1: Wire StorageFactory into app.js boot

| Field | Detail |
|-------|--------|
| **What** | Replace the `supabaseStorage.ensureBucket()` async IIFE at `app.js:7441-7451` with `StorageFactory.getStorageService()` init call |
| **Files** | `app.js` only |
| **Risk** | **Low** — factory wraps LegacyStorageAdapter which wraps supabase-storage. Same code path, just different entry point. |
| **Rollback** | Restore the original supabaseStorage IIFE (revert the 10-line change in `app.js:7441-7451`) |
| **Verification** | App starts without error. PDF upload/stream endpoints still work. |

### Sub-step 3.2: Replace `supabaseStorage` import with factory

| Field | Detail |
|-------|--------|
| **What** | Replace `const supabaseStorage = require('./supabase-storage')` at `app.js:15` with factory import. Replace all `supabaseStorage.*` calls in PDF endpoints with `storageService.*` via the factory. |
| **Files** | `app.js` (~6-8 call sites in lines 2531-2671) |
| **Risk** | **Medium** — the PDF token/stream endpoints are complex (auth + Range header + streaming). Must ensure LegacyStorageAdapter.createSignedUrl() matches exactly. |
| **Rollback** | Revert the import and all call sites to supabaseStorage. |
| **Verification** | Open a lesson PDF, a review PDF, and a note PDF. Verify same-origin stream works. Verify Range header seeking works. |

### Sub-step 3.3: Replace `supabaseStorage.uploadPdf` call sites

| Field | Detail |
|-------|--------|
| **What** | Replace `POST /api/admin/upload-pdf/sign`, `POST /api/admin/upload-pdf`, `POST /api/admin/upload-pdf-legacy` to use `StorageService.createSignedUploadUrl()` and `StorageService.upload()` |
| **Files** | `app.js` (lines 2627-2671) |
| **Risk** | **Medium** — the direct browser→Supabase upload flow changes. The signed URL format differs between Supabase and R2. |
| **Rollback** | Revert to supabaseStorage calls. The `public/js/pdf-upload.js` still has both direct and legacy paths. |
| **Verification** | Upload a PDF via admin UI. Verify it appears in lesson/review/note. |

### Sub-step 3.4: Replace `POST /api/admin/upload-note-file`

| Field | Detail |
|-------|--------|
| **What** | Replace `fs.writeFileSync()` at `app.js:6820` with `StorageService.upload()`. Return `objectKey` instead of `/uploads/notes/{filename}`. |
| **Files** | `app.js` (lines 6810-6825) |
| **Risk** | **High** — this is a local filesystem upload that currently works. Changing to R2 requires env vars. If R2 is not configured, this endpoint breaks. |
| **Rollback** | Restore `fs.writeFileSync()` path. |
| **Verification** | Upload a note file. Verify it can be downloaded. |

### Sub-step 3.5: Remove local filesystem serving

| Field | Detail |
|-------|--------|
| **What** | Remove `app.use('/uploads', express.static(...))` at `app.js:240` |
| **Files** | `app.js` only |
| **Risk** | **High** — if any code still references `/uploads/` URLs, they will 404. Must ensure no note files or other content still uses this path. |
| **Rollback** | Restore the `express.static` line. |
| **Verification** | No `/uploads/` references return 404. All content loads via signed URLs. |

---

## Risk Summary by Sub-step

| Sub-step | Risk | Why | Rollback |
|----------|------|-----|----------|
| 3.1 | Low | Factory wraps LegacyStorageAdapter — same code underneath | Revert 10 lines in app.js |
| 3.2 | Medium | PDF streaming is complex with Range headers | Revert import + call sites |
| 3.3 | Medium | Browser→Supabase direct upload changes | Revert to supabaseStorage calls |
| 3.4 | High | Note upload breaks if R2 not configured | Restore fs.writeFileSync |
| 3.5 | High | Static serving removal may break existing URLs | Restore express.static line |

---

## Implementation Order Recommendation

```
3.1 (app.js init) → 3.2 (PDF read) → 3.3 (PDF upload) → 3.4 (Note upload) → 3.5 (Remove local FS)
```

Each sub-step should be a separate commit with verification before proceeding to the next. After sub-steps 1-3, set `STORAGE_PROVIDER=r2` in a staging environment to test the full R2 path before any production impact.

---

*End of audit report. No code changes were made. Awaiting approval for Step 3 scope.*
