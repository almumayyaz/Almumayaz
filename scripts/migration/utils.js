const crypto = require('crypto');

function safeDate(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  return null;
}

function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return isNaN(n) ? fallback : n;
}

function safeBoolean(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return fallback;
}

function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function newCuid() {
  return crypto.randomUUID();
}

async function batchInsert({ prisma, model, records, batchSize = 100, logger, entity }) {
  let created = 0;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    try {
      await prisma[model].createMany({ data: batch, skipDuplicates: true });
      created += batch.length;
    } catch (e) {
      if (logger) logger.warn(entity, `Batch insert error at offset ${i}: ${e.message}`);
    }
    if (logger) logger.batch(entity, Math.min(i + batchSize, records.length), records.length);
  }
  return created;
}

module.exports = {
  safeDate,
  safeNumber,
  safeBoolean,
  safeString,
  newCuid,
  batchInsert,
};
