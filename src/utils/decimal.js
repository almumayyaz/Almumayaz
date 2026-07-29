// Decimal conversion utility
// Prisma returns Decimal fields as strings; controllers expect numbers.
// This utility converts Decimal fields at the service → controller boundary.

function convertDecimalFields(obj, fieldNames) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => convertDecimalFields(item, fieldNames));

  const result = { ...obj };
  for (const field of fieldNames) {
    const val = result[field];
    if (val !== undefined && val !== null) {
      // Prisma Decimal is returned as string (or number if it was Float)
      result[field] = typeof val === 'string' ? parseFloat(val) : Number(val);
    }
  }
  return result;
}

function pickDecimalFields(obj, fieldNames) {
  return convertDecimalFields(obj, fieldNames);
}

module.exports = { convertDecimalFields, pickDecimalFields };
