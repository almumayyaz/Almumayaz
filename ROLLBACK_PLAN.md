# ROLLBACK PLAN — Production Rollback Procedures

## Rollback Principles

1. **Never delete legacy data** — Legacy collections remain intact throughout migration
2. **Every phase is independently rollback-safe**
3. **Rollback = switch reads/writes back to legacy + delete V2 data**
4. **Document every rollback step** — Scripts are automated where possible

## Rollback Categories

### Category 1: Code Rollback
Revert code changes without affecting data.

```bash
# Revert to previous commit
git revert HEAD
git push origin main

# Re-deploy
npx vercel deploy --prod
```

### Category 2: Data Rollback (Migration Phase)
Delete V2 documents created during migration.

```bash
# Rollback specific migration phase
npm run migrate:rollback -- --phase=3

# Verify legacy data is intact
npm run migrate:validate -- --phase=3 --source=legacy
```

### Category 3: Read/Write Switch Rollback
Revert from V2 back to legacy data sources.

```bash
# 1. Set feature flag to use legacy
# 2. Verify legacy reads work
# 3. Disable V2 read path
# 4. Monitor for errors
```

## Phase-by-Phase Rollback

### Phase 1 Rollback (Foundations)
```
Objective: Remove repository + service layer code
Steps:
  1. Delete src/repositories/ directory
  2. Delete src/services/ directory
  3. Remove require() imports from app.js
  4. Revert app.js to use old data access patterns
```

### Phase 2 Rollback (Metadata Migration)
```
Objective: Delete V2 settings/users collections
Steps:
  1. Run: npm run rollback:phase2
     → Deletes: settings/{id} documents
     → Deletes: users/{id} documents (only newly migrated)
  2. Verify: readData('settings') returns legacy data
  3. Verify: readData('users') returns legacy data
```

### Phase 3 Rollback (Course Content)
```
Objective: Delete V2 course structure collections
Steps:
  1. Run: npm run rollback:phase3
     → Deletes: courses/{id} (only migrated docs)
     → Deletes: units/{id} (all)
     → Deletes: lessons/{id} (all)
     → Deletes: lessonVideos/{id} (all)
     → Deletes: lessonFiles/{id} (all)
     → Deletes: quizzes/{id} (all)
     → Deletes: questions/{id} (all)
  2. Verify: legacy course read works
  3. Verify: course.lessons.length === migrated lesson count
```

### Phase 4 Rollback (Student Data)
```
Objective: Delete V2 progress/attempts collections
Steps:
  1. Run: npm run rollback:phase4
     → Deletes: studentProgress/{id} (all)
     → Deletes: studentLessonProgress/{id} (all)
     → Deletes: studentExamAttempts/{id} (all)
     → Deletes: studentBookmarks/{id} (all)
     → Deletes: studentNotes/{id} (all)
  2. Verify: legacy user.progress exists
```

### Phase 5 Rollback (Activity Data)
```
Objective: Delete V2 activity collections
Steps:
  1. Run: npm run rollback:phase5
     → Deletes: notifications/{id} (only migrated)
     → Deletes: announcements/{id} (only migrated)
     → Deletes: chargeCodes/{id} (only migrated)
  2. Verify: legacy collections intact
```

### Phase 6-9 Rollback (Read/Write Switch)
```
Objective: Revert to legacy read/write paths
Steps:
  1. Deploy previous version that uses legacy reads
  2. Monitor error rates for 24 hours
  3. If errors < baseline, rollback is complete
  4. Keep V2 collections as backup (don't delete)
```

## Emergency Rollback

If production is broken:

```bash
# 1. Immediate: Revert deployment
vercel rollback

# 2. Verify: Run smoke tests
npm run test:smoke

# 3. Investigate: Check error logs
npm run logs -- --tail=100

# 4. If data corruption: Restore from backup
npm run restore -- --date=2024-01-01
```

## Rollback Validation

After any rollback:
1. Run smoke tests on all critical paths
2. Verify data integrity (counts match pre-migration)
3. Check error logs for 5 minutes
4. Verify all API endpoints return 200
5. Check student-facing pages load correctly

## Rollback Script Template

```javascript
// migrations/rollback-phase3.js
async function rollbackPhase3() {
  const collections = ['courses', 'units', 'lessons', 'lessonVideos', 'lessonFiles', 'quizzes', 'questions'];
  
  for (const col of collections) {
    const snap = await db.collection(col).get();
    const batch = db.batch();
    let count = 0;
    
    snap.forEach(doc => {
      batch.delete(doc.ref);
      count++;
    });
    
    await batch.commit();
    console.log(`Deleted ${count} documents from ${col}`);
  }
  
  console.log('Phase 3 rollback complete');
}
```

## Important Rollback Notes

- **RTDB data** (presence, chat, attendance): No rollback needed (ephemeral)
- **Data written after migration**: Must be re-migrated after rollback
- **ID conflicts**: Ensure V2 IDs don't conflict with legacy IDs
- **Cascade deletes**: Some V2 deletes may cause reference errors in services — these are handled gracefully (return null for missing refs)
