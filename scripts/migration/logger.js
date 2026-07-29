const MigrationLogger = require('../migration-logger');

class MigrationLoggerExtended extends MigrationLogger {
  warn(entity, message) {
    const entry = this.logs.find(l => l.entity === entity);
    if (entry) {
      entry.errors.push(message);
    }
    console.warn(`  [${entity}] ⚠ ${message}`);
  }

  logSkipped(entity, legacyId, reason) {
    const entry = this.logs.find(l => l.entity === entity);
    if (entry) entry.skipped++;
    console.log(`  [${entity}] ~ Skipped ${legacyId}: ${reason}`);
  }

  logCreated(entity, legacyId, newId) {
    const entry = this.logs.find(l => l.entity === entity);
    if (entry) entry.created++;
    if (process.env.VERBOSE_MIGRATION) {
      console.log(`  [${entity}] + Created ${legacyId} → ${newId}`);
    }
  }

  logDuplicate(entity, legacyId, keptId, removedId) {
    const entry = this.logs.find(l => l.entity === entity);
    if (entry) entry.skipped++;
    console.log(`  [${entity}] ~ Duplicate email: ${legacyId} → kept ${keptId}, removed ${removedId}`);
  }

  logFailed(entity, legacyId, error) {
    const entry = this.logs.find(l => l.entity === entity);
    if (entry) {
      entry.failed++;
      entry.errors.push(`[${legacyId}] ${error.message || error}`);
    }
    console.error(`  [${entity}] ✗ Failed ${legacyId}: ${error.message || error}`);
  }

  logAction(entity, legacyId, action, status, errorMsg) {
    const entry = this.logs.find(l => l.entity === entity);
    if (!entry) return;
    if (status === 'failed') {
      entry.failed++;
      if (errorMsg) entry.errors.push(`[${legacyId}] ${errorMsg}`);
    }
  }
}

module.exports = MigrationLoggerExtended;
