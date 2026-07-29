# Bootstrapping Architecture Review

> Pre-Step 3. Read-only. No code was modified.
> Goal: Decide where StorageService lives, how it's initialized, how it's injected — without app.js being the central hub.

---

## 1. Current app.js Responsibilities (Storage-Related)

| Responsibility | Lines | Should Stay? |
|---------------|-------|-------------ش|
| `const supabaseStorage = require('./supabase-storage')` | 15 | ❌ Move to provider |
| `const multer = require('multer')` + config | 273-283 | ❌ Move to config |
| `const fontUpload = multer(...)` | 4549-4558 | ❌ Move to config |
| `app.use('/uploads', express.static(...))` | 240 | ❌ Move to static config |
| Supabase bucket init IIFE | 7441-7451 | ❌ Move to bootstrap |
| PDF upload routes (sign, verify, legacy) | 2627-2671 | ❌ Move to route modules (future) |
| PDF token endpoints | 2521-2605 | ❌ Move to route modules (future) |
| Note file upload | 6810-6825 | ❌ Move to handler |
| Font upload route | 4561-4578 | ❌ Move to handler |
| Chat send routes (image) | 3517-3568 | ❌ Move to route modules (future) |
| Avatar/profile update | 2942-2968 | ❌ Move to handler |
| Payment submit routes (receipt) | 2861-2885, 3307-3333 | ❌ Move to handlers |

**Current problem**: app.js is responsible for initialization + configuration + route handling. The new architecture should separate these concerns.

---

## 2. Proposed Architecture

```
src/
├── bootstrap/
│   ├── index.js          ← Orchestrates all provider initialization
│   ├── storage.js        ← Creates StorageService singleton, does async init
│   ├── cache.js          ← Future: cache init
│   └── email.js          ← Future: email provider init
├── config/
│   ├── storage.js        ← Feature flag (already exists)
│   ├── multer.js         ← Multer config (extracted from app.js)
│   └── static.js         ← Static file serving config
├── providers/
│   ├── storage/
│   │   ├── StorageProvider.js
│   │   ├── CloudflareR2Provider.js
│   │   ├── LegacyStorageAdapter.js
│   │   ├── StorageService.js
│   │   ├── StorageFactory.js
│   │   └── index.js
│   ├── cache/            ← Future
│   └── email/            ← Future
├── services/
├── controllers/
├── repositories/
└── routes/
```

---

## 3. Where Everything Lives

### 3.1 StorageService Singleton → `src/bootstrap/storage.js`

```js
// Pseudocode
const { StorageFactory } = require('../providers/storage/StorageFactory');

let _service = null;

async function initStorage() {
  if (_service) return _service;
  _service = StorageFactory.getStorageService();
  // If using R2, this creates S3Client + validates env vars.
  // If using legacy, this wraps supabase-storage.
  return _service;
}

function getStorage() {
  if (!_service) throw new Error('Storage not initialized');
  return _service;
}

module.exports = { initStorage, getStorage };
```

**Why here**: Bootstrap is the app's initialization layer. `initStorage()` is called once at boot. After that, `getStorage()` is available anywhere — routes, services, controllers.

### 3.2 Provider Loading → `src/providers/storage/StorageFactory.js`

Already exists. Reads `STORAGE_PROVIDER` env var. Returns either `LegacyStorageAdapter` or `CloudflareR2Provider` wrapped in `StorageService`.

```
Env var ─→ StorageFactory ─→ StorageService ─→ StorageProvider
                                                   ├── LegacyStorageAdapter (wraps supabase-storage)
                                                   └── CloudflareR2Provider (uses @aws-sdk/client-s3)
```

### 3.3 Initialization → `src/bootstrap/index.js`

```js
async function bootstrap() {
  const storage = require('./storage');
  await storage.initStorage();
  // Future: await initCache(), await initEmail()
  return {
    storage: storage.getStorage()
    // cache: cache.getCache(),
    // email: email.getEmail()
  };
}
```

### 3.4 Injection into Routes → Via `app.locals` + Route Modules

```js
// app.js — after bootstrap
bootstrap().then(({ storage }) => {
  app.locals.storage = storage;
  app.use('/api', require('./src/routes')(app));
  app.listen(PORT);
});
```

Routes access storage:
```js
// Inside a route handler
const storage = req.app.locals.storage;
const signedUrl = await storage.createSignedUrl(objectKey, 60);
```

**No global variable, no require() dependency on a singleton module.** `app.locals` is Express's built-in DI mechanism.

### 3.5 Multer Configuration → `src/config/multer.js`

```js
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => { /* ... */ }
});
const fontUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => { /* ... */ }
});
module.exports = { upload, fontUpload };
```

Routes import multer from config instead of app.js defining it.

---

## 4. What Stays in app.js After Refactor

```
app.js — Final State:
├── Express app creation
├── Security middleware (helmet, CSP, HSTS)
├── Body parsing middleware
├── Session middleware
├── Compression middleware
├── bootstrap().then() ─→ mount routes ─→ listen
├── Static file serving (public/ only, not uploads/)
└── Global error handler
```

That's it. ~50 lines instead of ~7600. All business logic moves to `src/routes/`, `src/controllers/`, `src/services/`.

---

## 5. Per-Feature Storage Decision

### Feature 1: Avatars

| Decision | Value |
|----------|-------|
| Public or Private | **Public** (profile pictures are not sensitive) |
| URL Type | **Public URL** via CDN (`${R2_PUBLIC_URL}/avatars/...`) |
| Signed URL | Not needed — avatars are public by design |
| Streaming | Not needed — small files |
| Direct Download | Not needed — displayed inline |
| Object Key | `avatars/{userId}/avatar-{uuid}.{ext}` |
| Cache Strategy | `public, max-age=31536000, immutable` |
| ACL | Public-read |
| Signed URL Expiry | N/A |
| Versioning | Not needed (overwrite on re-upload) |
| Metadata | `{ userId, originalName }` |
| Content-Disposition | `inline` |
| Content-Type Override | From upload (image/jpeg, image/png, image/webp) |

### Feature 2: Chat Images

| Decision | Value |
|----------|-------|
| Public or Private | **Private** (chat is student-admin private) |
| URL Type | **Signed URL** (short-lived, per-request) |
| Signed URL | Yes, 1 hour expiry |
| Streaming | Not needed (images are small) |
| Direct Download | Optional (user can download via signed URL) |
| Object Key | `chats/{sessionId}/{messageId}-{uuid}.{ext}` |
| Cache Strategy | `private, max-age=0, must-revalidate` |
| ACL | Private (no public access) |
| Signed URL Expiry | 3600 seconds (1 hour) |
| Versioning | Not needed |
| Metadata | `{ sessionId, senderId, messageId }` |
| Content-Disposition | `inline` |
| Content-Type Override | From upload |

### Feature 3: Payment Receipts

| Decision | Value |
|----------|-------|
| Public or Private | **Private** (financial document) |
| URL Type | **Signed URL** (admin-only access) |
| Signed URL | Yes, 300 seconds (5 min) |
| Streaming | Not needed |
| Direct Download | Optional (admin may download) |
| Object Key | `payments/{paymentId}/receipt-{uuid}.{ext}` |
| Cache Strategy | `private, no-cache` |
| ACL | Private |
| Signed URL Expiry | 300 seconds |
| Versioning | Not needed |
| Metadata | `{ userId, paymentId, transactionId }` |
| Content-Disposition | `inline` |
| Content-Type Override | From upload |

### Feature 4: Subscription Request Receipts

| Decision | Value |
|----------|-------|
| Public or Private | **Private** (financial document) |
| URL Type | **Signed URL** (admin-only) |
| Signed URL | Yes, 300 seconds |
| Object Key | `subrequests/{subReqId}/receipt-{uuid}.{ext}` |
| Everything else | Same as Payment Receipts |

### Feature 5: Lesson PDFs

| Decision | Value |
|----------|-------|
| Public or Private | **Private** (subscription-gated) |
| URL Type | **Signed URL + Server Proxy** (keep current pattern) |
| Signed URL | Yes, 60 seconds (server proxy refreshes) |
| Streaming | **Yes** — Range header passthrough for large PDFs |
| Direct Download | Not directly — through proxy only |
| Object Key | `lessons/{lessonId}/{fileId}-{uuid}.pdf` |
| Cache Strategy | `private, max-age=0, must-revalidate` |
| ACL | Private |
| Signed URL Expiry | 60 seconds |
| Versioning | Not needed |
| Metadata | `{ lessonId, courseId, originalName, size }` |
| Content-Disposition | `inline` (display in PDF viewer) |
| Content-Type Override | `application/pdf` (force) |

**Note**: The server-side stream proxy should be kept for PDFs because:
1. Range headers for large PDFs work reliably through server proxy
2. Auth + subscription check happens server-side before any R2 access
3. The browser never touches R2 directly — single-origin URLs for PDF.js

### Feature 6: Review PDFs

Same as Lesson PDFs. Object key: `reviews/{reviewId}/{fileId}-{uuid}.pdf`

### Feature 7: Note Files

| Decision | Value |
|----------|-------|
| Public or Private | **Mixed** — depends on note visibility (some are subscription-gated, some free) |
| URL Type | **Signed URL** (auth check on read) |
| Signed URL | Yes, 300 seconds |
| Streaming | Not needed (files are small to medium) |
| Direct Download | Optional |
| Object Key | `notes/{noteId}/{uuid}-{original}.{ext}` |
| Cache Strategy | `private, max-age=0, must-revalidate` |
| ACL | Private |
| Signed URL Expiry | 300 seconds |
| Versioning | Not needed |
| Metadata | `{ noteId, courseId, originalName, type }` |
| Content-Disposition | `inline` for PDF/images, `attachment` for other types |
| Content-Type Override | From upload |

### Feature 8: Font Files

| Decision | Value |
|----------|-------|
| Public or Private | **Public** (fonts are loaded by all users, part of the theme) |
| URL Type | **Public URL** via CDN |
| Signed URL | Not needed |
| Streaming | Not needed |
| Direct Download | Font files are downloaded by browser automatically |
| Object Key | `fonts/{fontName}-{uuid}.{ext}` |
| Cache Strategy | `public, max-age=31536000, immutable` |
| ACL | Public-read |
| Signed URL Expiry | N/A |
| Versioning | Yes — font name includes hash, new upload = new key |
| Metadata | `{ originalName, format }` |
| Content-Disposition | `inline` (browser loads via @font-face) |
| Content-Type Override | `font/woff2` or appropriate |

### Feature 9: Chat Attachments (Future)

Same as Chat Images but with streaming support for large files. Object key: `chat-attachments/{sessionId}/{attachmentId}-{uuid}.{ext}`

---

## 6. Final Configuration Table

| Feature | Private/Public | URL Type | Folder | Cache | Signed Expiry | Content-Disposition |
|---------|---------------|----------|--------|-------|---------------|---------------------|
| Avatar | **Public** | Public URL | `avatars/{userId}/` | 1 year immutable | N/A | inline |
| Chat Image | **Private** | Signed URL | `chats/{sessionId}/` | no-cache | 3600s | inline |
| Payment Receipt | **Private** | Signed URL | `payments/{paymentId}/` | no-cache | 300s | inline |
| SubReq Receipt | **Private** | Signed URL | `subrequests/{subReqId}/` | no-cache | 300s | inline |
| Lesson PDF | **Private** | Signed + Proxy | `lessons/{lessonId}/` | must-revalidate | 60s | inline |
| Review PDF | **Private** | Signed + Proxy | `reviews/{reviewId}/` | must-revalidate | 60s | inline |
| Note File | **Private** | Signed URL | `notes/{noteId}/` | must-revalidate | 300s | inline/attachment |
| Font | **Public** | Public URL | `fonts/` | 1 year immutable | N/A | inline |
| Chat Attachment | **Private** | Signed URL | `chat-attachments/{sessionId}/` | no-cache | 3600s | inline/attachment |

---

## 7. Recommendation

### ❌ Do NOT keep Storage initialization in app.js

app.js should be pure Express setup. Storage initialization is an infrastructure concern, not an Express concern.

### ✅ Create `src/bootstrap/` as an independent initialization layer

```
app.js
  │
  └── calls bootstrap() ───→ src/bootstrap/index.js
                                  │
                                  ├── storage.js     ← StorageService singleton
                                  ├── cache.js       ← Future
                                  └── email.js       ← Future
                                  │
                                  └── returns { storage, ... } → injected via app.locals
```

### Benefits

| Benefit | Detail |
|---------|--------|
| **Separation of concerns** | app.js handles HTTP, bootstrap handles infrastructure |
| **Testability** | `bootstrap()` can be called in tests without starting Express |
| **Extensibility** | New providers (cache, email, queue) added to bootstrap without touching app.js |
| **Clean app.js** | ~50 lines instead of ~7600 |
| **Singleton management** | Bootstrapping layer owns the lifecycle of all providers |
| **Graceful shutdown** | Bootstrap can add shutdown hooks for all providers |

### Future Bootstrap Growth

```js
// src/bootstrap/index.js (future state)
async function bootstrap() {
  const storage   = await require('./storage').initStorage();
  const cache     = await require('./cache').initCache();     // Future
  const email     = await require('./email').initEmail();     // Future
  const queue     = await require('./queue').initQueue();     // Future
  return { storage, cache, email, queue };
}
```

---

## 8. Summary of All Findings

| Metric | Count |
|--------|-------|
| Active storage features | 8 (avatars, chat images, payment receipts, sub request receipts, lesson PDFs, review PDFs, note files, fonts) |
| Dead models | 1 (ChatAttachment — never populated) |
| Storage points with no delete cleanup | 3 (lesson PDFs, review PDFs, note files — orphaned on delete) |
| Features needing Public URL | 2 (avatars, fonts) |
| Features needing Signed URL | 6 (chat images, payment receipts, sub request receipts, lesson PDFs, review PDFs, note files) |
| Features needing Server Proxy | 2 (lesson PDFs, review PDFs — for Range header + auth) |
| Features needing Signed Upload URL | Potentially all (for direct browser→R2 upload) |
| Storage backends to retire | 3 (Firebase RTDB base64, Firebase Firestore base64, Supabase Storage, Local filesystem) |
| Target backends | 1 (Cloudflare R2) |
| Init locations to create | 2 (`src/bootstrap/index.js`, `src/bootstrap/storage.js`) |
| Config files to extract | 2 (`src/config/multer.js`, `src/config/static.js`) |

---

*End of Bootstrapping Architecture Review. No code was modified. Awaiting approval of the new bootstrapping architecture before any implementation.*
