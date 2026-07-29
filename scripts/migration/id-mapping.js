const { getClient } = require('./client');

async function createMapping(entityType, legacyId, newId) {
  const prisma = getClient();
  const existing = await prisma.idMapping.findFirst({
    where: { entityType, legacyId },
  });
  if (existing) return existing;
  return prisma.idMapping.create({
    data: { entityType, legacyId, newId },
  });
}

async function findMapping(entityType, legacyId) {
  if (!legacyId) return null;
  const prisma = getClient();
  return prisma.idMapping.findFirst({
    where: { entityType, legacyId },
  });
}

async function hasMapping(entityType, legacyId) {
  const m = await findMapping(entityType, legacyId);
  return !!m;
}

async function resolveId(entityType, legacyId) {
  if (!legacyId) return null;
  const m = await findMapping(entityType, legacyId);
  return m ? m.newId : null;
}

async function getMappingCount() {
  const prisma = getClient();
  return prisma.idMapping.count();
}

module.exports = {
  createMapping,
  findMapping,
  hasMapping,
  resolveId,
  getMappingCount,
};
