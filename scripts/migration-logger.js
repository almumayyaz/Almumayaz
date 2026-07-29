class MigrationLogger {
  constructor(dryRun = false) {
    this.logs = [];
    this.startTime = Date.now();
    this.dryRun = dryRun;
  }

  prefix() { return this.dryRun ? '[DRY RUN] ' : ''; }

  start(entity) {
    const entry = {
      entity,
      startTime: new Date().toISOString(),
      endTime: null,
      durationMs: null,
      read: 0,
      found: 0,
      existing: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      status: 'running',
      batches: 0,
    };
    this.logs.push(entry);
    console.log(`\n${this.prefix()}[${entity}] Starting migration...`);
    return entry;
  }

  batch(entity, processed, total) {
    const entry = this.logs.find(l => l.entity === entity);
    if (entry) entry.batches++;
    if (total > 0) {
      const pct = Math.round((processed / total) * 100);
      process.stdout.write(`\r  ${this.prefix()}[${entity}] ${processed}/${total} (${pct}%)`);
    }
  }

  read(entity, count) {
    const entry = this.logs.find(l => l.entity === entity);
    if (entry) entry.read = count;
  }

  found(entity, count) {
    const entry = this.logs.find(l => l.entity === entity);
    if (entry) entry.found = count;
  }

  existing(entity, count) {
    const entry = this.logs.find(l => l.entity === entity);
    if (entry) entry.existing = count;
  }

  done(entity, created, skipped, updated = 0) {
    const entry = this.logs.find(l => l.entity === entity);
    if (!entry) return;
    entry.created = created;
    entry.skipped = skipped;
    entry.updated = updated;
    entry.endTime = new Date().toISOString();
    entry.durationMs = Date.now() - new Date(entry.startTime).getTime();
    entry.status = 'completed';
    const rowsPerSec = entry.durationMs > 0
      ? ((created + updated) / (entry.durationMs / 1000)).toFixed(1)
      : '∞';
    console.log('');
    console.log(
      `  ${this.prefix()}[${entity}] ` +
      `Read: ${entry.read} | ` +
      `Created: ${created} | ` +
      `Updated: ${updated} | ` +
      `Existing/Skipped: ${skipped} | ` +
      `Failed: ${entry.failed} | ` +
      `Duration: ${(entry.durationMs / 1000).toFixed(1)}s | ` +
      `Rows/sec: ${rowsPerSec}`
    );
  }

  failure(entity, error) {
    const entry = this.logs.find(l => l.entity === entity);
    if (entry) {
      entry.failed++;
      entry.errors.push(error.message || String(error));
      entry.status = 'failed';
    }
    console.error(`  ${this.prefix()}[${entity}] ❌ Error: ${error.message || error}`);
  }

  summary() {
    const totalDuration = Date.now() - this.startTime;
    console.log('\n═══════════════════════════════════════════');
    console.log(this.prefix() + '    MIGRATION SUMMARY');
    console.log('═══════════════════════════════════════════');
    console.log(`Duration: ${(totalDuration / 1000).toFixed(1)}s${this.dryRun ? ' (DRY RUN)' : ''}`);
    console.log('');

    let grandCreated = 0;
    let grandErrors = 0;

    // Header
    console.log('  Entity                     Read   Created  Updated  Skipped  Failed  Duration  Rows/s');
    console.log('  ' + '─'.repeat(80));

    for (const entry of this.logs) {
      grandCreated += entry.created;
      grandErrors += entry.errors.length;
      const rowsPerSec = entry.durationMs > 0
        ? ((entry.created + entry.updated) / (entry.durationMs / 1000)).toFixed(1)
        : '∞';
      const icon = entry.errors.length > 0 ? '⚠️' : (entry.status === 'completed' ? '✅' : '⬜');
      const dur = entry.durationMs ? (entry.durationMs / 1000).toFixed(1) + 's' : '—';
      console.log(
        `  ${icon} ${entry.entity.padEnd(22)}` +
        `${String(entry.read).padStart(6)} ` +
        `${String(entry.created).padStart(7)} ` +
        `${String(entry.updated).padStart(8)} ` +
        `${String(entry.skipped + entry.existing).padStart(7)} ` +
        `${String(entry.failed).padStart(6)} ` +
        `${dur.padStart(8)} ` +
        `${rowsPerSec.padStart(7)}`
      );
    }

    console.log('');
    console.log(`  Total created: ${grandCreated} rows across ${this.logs.length} entities`);
    if (grandErrors > 0) console.log(`  Total errors: ${grandErrors}`);
    console.log(`  Overall: ${(grandCreated / (totalDuration / 1000)).toFixed(1)} rows/sec`);
    console.log('═══════════════════════════════════════════\n');
    return { logs: this.logs, totalDuration, grandCreated, grandErrors };
  }

  report() {
    return {
      dryRun: this.dryRun,
      startedAt: new Date(this.startTime).toISOString(),
      endedAt: new Date().toISOString(),
      entries: this.logs,
    };
  }
}

module.exports = MigrationLogger;
