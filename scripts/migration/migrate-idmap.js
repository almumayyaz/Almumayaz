require('dotenv').config();
const { getClient, disconnect } = require('./client');

async function migrateIdMappings() {
  const prisma = getClient();
  console.log('══════════════════════════════════');
  console.log('  MIGRATE IdMappings: Setting → IdMapping');
  console.log('══════════════════════════════════\n');

  const settings = await prisma.setting.findMany({
    where: { key: { startsWith: 'idmap:' } },
  });

  console.log(`Found ${settings.length} mappings in Setting table`);

  let transferred = 0;
  let skipped = 0;

  for (const s of settings) {
    const parts = s.key.split(':');
    if (parts.length < 3) {
      console.log(`  ~ Skipping invalid key: ${s.key}`);
      skipped++;
      continue;
    }
    const entityType = parts[1];
    const legacyId = parts.slice(2).join(':');
    const value = typeof s.value === 'string' ? JSON.parse(s.value) : s.value;
    const newId = value.newId;

    if (!newId) {
      console.log(`  ~ Skipping ${s.key}: no newId in value`);
      skipped++;
      continue;
    }

    const existing = await prisma.idMapping.findFirst({
      where: { entityType, legacyId },
    });

    if (existing) {
      console.log(`  ~ Already exists: ${entityType}:${legacyId} → ${newId}`);
      skipped++;
      continue;
    }

    await prisma.idMapping.create({
      data: { entityType, legacyId, newId },
    });
    console.log(`  + Transferred: ${entityType}:${legacyId} → ${newId}`);
    transferred++;
  }

  console.log('\n══════════════════════════════════');
  console.log('  SUMMARY');
  console.log('══════════════════════════════════');
  console.log(`  Found in Setting:     ${settings.length}`);
  console.log(`  Transferred:          ${transferred}`);
  console.log(`  Skipped:              ${skipped}`);

  const totalInIdMapping = await prisma.idMapping.count();
  const totalInSetting = await prisma.setting.count({
    where: { key: { startsWith: 'idmap:' } },
  });

  console.log(`  IdMapping table:      ${totalInIdMapping}`);
  console.log(`  Setting table:        ${totalInSetting}`);
  console.log(`  Match:                ${totalInIdMapping === totalInSetting ? '✅ YES' : '⚠️ NO'}`);

  if (totalInIdMapping === totalInSetting) {
    console.log('\n✅ All mappings transferred successfully');
  } else {
    console.log('\n⚠️ Count mismatch — check logs above');
  }
}

migrateIdMappings()
  .catch(e => { console.error('FATAL:', e.message); process.exit(1); })
  .finally(() => disconnect());
