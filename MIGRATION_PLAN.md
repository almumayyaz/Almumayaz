# MIGRATION PLAN — Legacy to V2

## Migration Strategy Overview

**Golden Rule:** Never delete legacy data automatically. Legacy collections remain untouched throughout migration. Only reads/writes are switched.

### Migration Phases

```
Phase 1: Foundations
  → Create V2 collection structure
  → Build repository layer
  → Build migration services

Phase 2: Metadata Migration
  → Migrate settings, themeConfig, appConfig, maintenanceMode
  → Migrate users (basic fields, no progress)

Phase 3: Course Content Migration
  → Migrate courses → units → lessons → videos → files
  → Migrate embedded quizzes → quizzes + questions
  → Migrate reviews (embedded media)

Phase 4: Student Data Migration
  → Migrate progress → studentProgress + studentLessonProgress
  → Migrate examResults → studentExamAttempts
  → Migrate bookmarks, notes

Phase 5: Activity Data Migration
  → Migrate notifications, announcements, supportTickets
  → Migrate payments, subscriptions, enrollments
  → Migrate chargeCodes (RTDB → Firestore)

Phase 6: Validation + Verification
  → Validate all relationships
  → Verify data integrity
  → Performance testing

Phase 7: Switch Reads
  → Update routes to read from V2 collections
  → Dual-read (read from V2, fallback to legacy)
  → Monitor for issues

Phase 8: Switch Writes
  → Update routes to write to V2 collections
  → Dual-write (write to V2 + legacy during transition)
  → Monitor for issues

Phase 9: Archive Legacy
  → Remove legacy read/write paths
  → Keep legacy data as backup
  → Update documentation
```

## Migration Script Architecture

```
migrations/
  index.js           — Migration orchestrator
  migrate-settings.js
  migrate-users.js
  migrate-courses.js
  migrate-progress.js
  migrate-payments.js
  validate-migration.js
  rollback-migration.js
```

### Migration Service Pattern

```javascript
// Each migration service follows this pattern:
class MigrationService {
  async migrate(options) {
    // 1. Read from legacy source
    // 2. Transform to V2 format
    // 3. Batch write to V2 collections
    // 4. Verify written data
    // 5. Log migration results
  }

  async validate(options) {
    // 1. Count legacy records
    // 2. Count V2 records
    // 3. Compare key fields
    // 4. Report discrepancies
  }

  async rollback(options) {
    // 1. Delete V2 documents created in this migration
    // 2. Verify legacy data is intact
    // 3. Report rollback status
  }
}
```

### Migration Execution

```bash
# Run all migrations
npm run migrate

# Run specific migration
npm run migrate -- --phase=2

# Validate migration
npm run migrate:validate -- --phase=2

# Rollback migration
npm run migrate:rollback -- --phase=2
```

## Data Transformation Rules

### ID Generation
```javascript
function generateId(prefix) {
  return `${prefix}_${Date.now()}_${randomBytes(4).toString('hex')}`;
}
// Legacy IDs are preserved in 'legacyId' field
```

### Timestamp Handling
```javascript
// Legacy timestamps are ISO strings → convert to Firestore Timestamp
// If missing → use current time
// If invalid → log warning, use current time
```

### Null/Empty Handling
```javascript
// Empty arrays → omit or store as empty array
// null fields → omit (Firestore doesn't store null by default)
// undefined values → skip
```

### Error Handling
```javascript
// Batch writes with error collection
// Failed documents logged to migration_errors collection
// Migration continues on failure (skip and report)
// Manual review for failed documents
```

## Migration Verification

After each phase, verify:
1. Document count matches (legacy vs V2)
2. Key field values match
3. Reference integrity (all referenced IDs exist)
4. No orphaned documents
5. No duplicate documents
