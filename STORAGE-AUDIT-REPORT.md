# Storage Audit Report — Vercel Deployment Optimization

**Date:** 2026-07-29  
**Current Project Size:** ~567 MB  

> ⚠️ **This is a report only. No files have been deleted.**

---

## 1. Size Report — Sorted by Directory/File

### 1.1 Top-Level Breakdown

| Directory/File | Size | Notes |
|---|---|---|
| `node_modules/` | 492.20 MB | Reinstalled by Vercel during build |
| `docs/` | 32.47 MB | Development only |
| `pg.zip` | 27.34 MB | Archive — not needed |
| `firebase-12.15.0.tgz` | 7.88 MB | Archive — not needed |
| `public/` | 2.36 MB | ✅ Runtime required |
| `all_calls.txt` | 1.06 MB | Log file — not needed |
| `views/` | 0.87 MB | ✅ Runtime required |
| `...all other markdown reports` | ~0.50 MB | Development only |
| `app.js` | 0.39 MB | ✅ Runtime required |
| `.agents/`, `.claude/`, `.windsurf/` | ~0.90 MB | IDE configs — not needed |
| `firebase-admin-12.7.0.tgz` | 0.24 MB | Archive — not needed |
| `src/` | 0.22 MB | ✅ Runtime required |
| `scripts/` | 0.17 MB | Development only |
| `prisma/` | 0.08 MB | ✅ Runtime required (migrations) |
| `services/`, `data/`, `logs/` | ~0.08 MB | Development/migration only |
| Others | ~0.10 MB | Mixed |
| **Total (excluding `.git`)** | **~567 MB** | |

### 1.2 Key Large Files

| File | Size | Status |
|---|---|---|
| `docs/loadtest/results.json` | 32.31 MB | ❌ Not needed |
| `pg.zip` | 27.34 MB | ❌ Not needed |
| `firebase-12.15.0.tgz` | 7.88 MB | ❌ Not needed |
| `all_calls.txt` | 1.06 MB | ❌ Not needed |
| `firebase-admin-12.7.0.tgz` | 0.24 MB | ❌ Not needed |
| `public/js/pdf.worker.min.js` | 1.04 MB | ✅ Runtime |
| `public/js/pdf.min.js` | 0.31 MB | ✅ Runtime |

---

## 2. Unnecessary Files Detected

### Archives / Downloads

| File | Size | Reason to exclude |
|---|---|---|
| `pg.zip` | 27.34 MB | Downloaded PostgreSQL package — not used at runtime |
| `firebase-12.15.0.tgz` | 7.88 MB | Firebase SDK source — `firebase-admin` is installed via npm |
| `firebase-admin-12.7.0.tgz` | 0.24 MB | Same — installed via npm |

### Log Files

| Path | Size | Reason |
|---|---|---|
| `all_calls.txt` | 1.06 MB | Session transcript — not needed |
| `C:...all_files.txt` | 0.59 MB | Session transcript — not needed |
| `logs/` (multiple JSON files) | ~0.01 MB | Migration logs — not needed |
| `cookies.txt` | ~0.01 MB | Session file — not needed |

### Generated Markdown Reports (30+ files)

| Example files | Size (total) | Reason |
|---|---|---|
| `MIGRATION_FINAL_REPORT.md` | | |
| `PHASE4_REPORT.md` | | |
| `FINAL_PRODUCTION_HARDENING_REPORT.md` | | |
| `STORAGE-AUDIT-STEP3-READY.md` | | |
| ... and ~25 more `.md` files | ~0.50 MB | All are development documentation — not needed at runtime |

---

## 3. Development-Only Directories

| Directory | Size | Production Critical? | Recommendation |
|---|---|---|---|
| `docs/` | 32.32 MB | ❌ No | Exclude entirely (loadtest results = 32.3 MB alone) |
| `scripts/` | 0.17 MB | ❌ No | Migration scripts, preflight, verify — not needed after deployment |
| `migration-reports/` | ~0.00 MB | ❌ No | Empty directory |
| `logs/` | ~0.01 MB | ❌ No | Migration logs only |
| `data/` | ~0.03 MB | ❌ No | Local JSON backups of Firebase data — not used by runtime |
| `.agents/` | 0.30 MB | ❌ No | AI agent configurations |
| `.claude/` | 0.30 MB | ❌ No | AI agent configurations |
| `.windsurf/` | 0.30 MB | ❌ No | AI agent configurations |

---

## 4. Production-Critical Directories

| Directory | Size | Why Required |
|---|---|---|
| `public/` | 2.36 MB | Static assets (CSS, JS, images, PDF workers, icons) |
| `views/` | 0.87 MB | EJS templates — all pages rendered server-side |
| `api/` | ~0.00 MB | Vercel serverless entry point (`api/index.js`) |
| `prisma/` | 0.08 MB | Schema + migrations — needed for `prisma generate` at build |
| `src/` | 0.22 MB | V2 services, controllers, repositories, routes |

### Semi-Critical

| Directory | Size | Notes |
|---|---|---|
| `services/` | 0.02 MB | Firestore repositories + payment services — runtime fallback |
| `app.js` | 0.39 MB | Main Express app — ✅ required |
| `firebase-admin.js` | 0.02 MB | Firebase Admin SDK wrapper — ✅ required |
| `zoom-oauth.js` | 0.02 MB | Zoom OAuth — ✅ required |
| `server.js` | ~0.00 MB | Entry point — ✅ required |
| `prisma-bridge.js` | 0.01 MB | Prisma ↔ Firestore bridge — ✅ required |

---

## 5. Package.json Analysis

### Unused Dependencies (safe to remove)

| Package | Evidence | Risk |
|---|---|---|
| **`nodemailer`** | Not `require()`'d anywhere in runtime code. Email is sent via Brevo API. | 🟢 Low — 0 KB in prod (tree-shaken by Vercel) but adds to install time |
| **`puter`** | Not `require()`'d anywhere. Unknown purpose. | 🟢 Low — same as above |

### Dependency Audit

| Package | Usage | Runtime? | Notes |
|---|---|---|---|
| `@aws-sdk/client-s3` | `CloudflareR2Provider.js` | ✅ Yes | For R2 storage |
| `@aws-sdk/s3-request-presigner` | `CloudflareR2Provider.js` | ✅ Yes | For presigned URLs |
| `@prisma/adapter-neon` | `src/database.js` (Vercel env) | ✅ Yes | Neon serverless adapter |
| `@prisma/adapter-pg` | `src/database.js` (non-Vercel env) + scripts | ✅ Yes | PG adapter fallback |
| `pg` | `src/database.js` + migration scripts | ✅ Yes | Required by Prisma |
| `dotenv` | **devDependencies** | ✅ Correct | Only needed in development |
| `prisma` (CLI) | **devDependencies** | ✅ Correct | Only needed for migrations/generate |

### Recommendation for package.json

1. **Remove `nodemailer`** — unused, Brevo handles all email
2. **Remove `puter`** — unused
3. **Keep `mammoth`** — used in `app.js` for docx uploads
4. **Keep everything else** — confirmed in use

---

## 6. `.vercelignore` — Recommended Configuration

```
# Version control
.git
.gitignore

# IDE & AI config
.agents
.claude
.windsurf
.vscode
.idea

# Archives and downloads
*.zip
*.tgz
*.tar
*.gz
*.rar
*.7z
*.bak
*.old

# Logs and session files
*.log
all_calls.txt
cookies.txt
nul

# Documentation and reports
*.md
docs/
migration-reports/

# Migration scripts (not needed at runtime)
scripts/
data/
logs/

# Environment files (set in Vercel dashboard)
.env
.env.local
.env.vercel
.env.*
```

> Note: `node_modules/` is **always** excluded by Vercel automatically — no need to add it.

---

## 7. `.gitignore` — Recommended Additions

Add these (already have some, ensure complete):

```
# Archives
*.zip
*.tgz
*.tar
*.gz
*.rar
*.7z

# Session/log files
all_calls.txt
cookies.txt
nul

# Environment (keep .env.example if exists)
.env.local
.env.vercel
.env.production

# Vercel local state
.vercel
```

---

## 8. Prisma Migration Files

| Path | Required? | Reason |
|---|---|---|
| `prisma/schema.prisma` | ✅ Yes | Used by `prisma generate` at build time |
| `prisma/migrations/` | ✅ Yes | Used by Prisma at runtime to verify schema |
| `prisma/migrations/migration_lock.toml` | ✅ Yes | Required for migration integrity |

**Migration scripts** (in `scripts/migration/`) are **NOT** required at runtime — they were one-time data migration tools.

---

## 9. Estimated Size After Cleanup

### Deployment Upload Size (what Vercel receives)

| Category | Before | After | Reduction |
|---|---|---|---|
| Upload to Vercel | ~63 MB (project files + node_modules) | ~4 MB (only runtime files) | **~94%** |

> Vercel automatically excludes `node_modules` and `.git`. The "63 MB" seen during `vercel deploy` is the upload of all project files. After `.vercelignore`, this drops significantly.

### Breakdown (upload size to Vercel)

| Component | Current Size | After Cleanup |
|---|---|---|
| Source code (JS, EJS, JSON, config) | ~1.5 MB | ✅ 1.5 MB |
| `public/` assets | 2.36 MB | ✅ 2.36 MB |
| `node_modules/` | excluded by Vercel | excluded |
| `.md` reports (30+ files) | ~0.5 MB | ❌ 0 MB |
| `docs/` (loadtest results) | 32.3 MB | ❌ 0 MB |
| `pg.zip` | 27.3 MB | ❌ 0 MB |
| `.tgz` archives | 8.1 MB | ❌ 0 MB |
| `all_calls.txt` | 1.1 MB | ❌ 0 MB |
| `scripts/`, `data/`, `logs/` | ~0.2 MB | ❌ 0 MB |
| IDE configs (`.agents/`, etc) | ~0.9 MB | ❌ 0 MB |
| **Total Upload** | **~74 MB** | **~4 MB** |

---

## 10. Risk Assessment

### 🟢 SAFE TO DELETE (from local repo)

| Item | Size | Rationale |
|---|---|---|
| `pg.zip` | 27.34 MB | Downloaded file, not used by the app |
| `firebase-12.15.0.tgz` | 7.88 MB | NPM package source, not used |
| `firebase-admin-12.7.0.tgz` | 0.24 MB | Same |
| `all_calls.txt` | 1.06 MB | Session transcript |
| `cookies.txt` | ~0.00 MB | Temporary |
| `nul` | ~0.00 MB | Invalid filename |

### 🟢 SAFE TO EXCLUDE FROM VERCEL (.vercelignore)

| Item | Size | Rationale |
|---|---|---|
| `docs/` | 32.32 MB | Load test results + documentation |
| `scripts/` | 0.17 MB | One-time migration tools |
| `logs/` | ~0.01 MB | Migration logs |
| `data/` | ~0.03 MB | Local JSON backups |
| `migration-reports/` | ~0.00 MB | Empty |
| `.agents/` | 0.30 MB | IDE config |
| `.claude/` | 0.30 MB | IDE config |
| `.windsurf/` | 0.30 MB | IDE config |
| All `*.md` files | ~0.50 MB | Documentation/reports |
| `*.zip`, `*.tgz` | 35.46 MB | Archives |

### ✅ KEEP (Runtime Required)

| Item | Size | Why |
|---|---|---|
| `app.js` | 0.39 MB | Main application |
| `server.js` | ~0.00 MB | Entry point |
| `api/` | ~0.00 MB | Vercel serverless entry |
| `public/` | 2.36 MB | Static assets |
| `views/` | 0.87 MB | EJS templates |
| `prisma/` | 0.08 MB | Schema + migrations |
| `src/` | 0.22 MB | V2 service layer |
| `services/` | 0.02 MB | Runtime services |
| `firebase-admin.js` | 0.02 MB | Firebase SDK wrapper |
| `zoom-oauth.js` | 0.02 MB | Zoom OAuth |
| `prisma-bridge.js` | 0.01 MB | DB bridge |
| `email-service.js` | ~0.00 MB | Email service |
| `fcm-log.js` | ~0.00 MB | FCM logging |
| `analytics-engine.js` | 0.02 MB | Analytics |
| `usage-tracker.js` | ~0.00 MB | Usage tracking |
| `supabase-storage.js` | ~0.00 MB | Supabase storage |
| `data-store.js` | ~0.00 MB | Local data store fallback |
| `package.json` | ~0.00 MB | Dependencies |
| `vercel.json` | ~0.00 MB | Vercel config |

### 🟡 REQUIRES MANUAL REVIEW

| Item | Size | Question |
|---|---|---|
| `service-account.json` | ~0.00 MB | Firebase service account — check if needed at build time or only in Vercel env. **If referenced by code, keep. If only in Vercel env, exclude.** |
| `.env` + `.env.local` + `.env.vercel` | ~0.00 MB | Already excluded by `.gitignore`. Ensure they are also in `.vercelignore`. |

---

## 11. Final Recommendations

### Before Deploying to Vercel

1. **Create/update `.vercelignore`** with the configuration shown in Section 6 — this is the single most impactful change, reducing upload size from ~74 MB to ~4 MB (**94% reduction**).

2. **Remove unused npm packages** (`nodemailer`, `puter`) from `package.json` — small impact, good practice.

3. **Delete local archives** (`pg.zip`, `*.tgz`, `all_calls.txt`) — they bloat the local repo and have no value.

4. **Verify no runtime file references deleted paths** — the `.vercelignore` suggestions exclude only dev files. Double-check that `data/` and `scripts/` are not `require()`'d anywhere (they are not — confirmed by grep).

### Deployment Size Estimate

```
Current upload to Vercel:      ~63-74 MB
After .vercelignore cleanup:   ~4 MB
Size reduction:                94%
```

### Risk Summary

| Action | Risk Level | Impact |
|---|---|---|
| Add `.vercelignore` | 🟢 None | Vercel only — no local effect |
| Remove `nodemailer` + `puter` | 🟢 Low | Can be reinstalled if needed |
| Delete local archives | 🟢 Low | Download again if needed |
| Exclude `scripts/`, `data/`, `logs/` | 🟢 None | Not referenced at runtime |
| Exclude `docs/` | 🟢 None | Documentation only |
| Exclude `*.md` | 🟢 None | Documentation only |
| Exclude IDE configs | 🟢 None | Not used by the app |

> **Overall risk of cleanup: 🟢 Very Low** — all exclusions are development-only files with zero runtime references.
