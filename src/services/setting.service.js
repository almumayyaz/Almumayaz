const { recordAuditLog, ACTIONS } = require('../utils/auditLog');
const { settingRepo } = require('../repositories');

async function getSettings() {
  const rows = await settingRepo.list();
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

async function getByKey(key) {
  const row = await settingRepo.findBy('key', key);
  if (!row) return null;
  return { key: row.key, value: row.value };
}

async function updateSettings(body, actor) {
  const allowed = ['vodafoneCash', 'instaPay', 'contactPhone', 'contactEmail', 'contactAddress', 'contactWhatsapp', 'referralDiscount', 'currentSemester', 'announcementsEnabled'];
  for (const key of allowed) {
    if (body[key] !== undefined) {
      await settingRepo.upsert(
        { key },
        { key, value: body[key] },
        { value: body[key] }
      );
    }
  }
  await recordAuditLog({ actorId: actor, action: ACTIONS.SETTINGS_UPDATE, entity: 'Setting', metadata: { updatedKeys: Object.keys(body).filter(k => allowed.includes(k)) }, ip: body._ip, userAgent: body._ua });
  const rows = await settingRepo.list();
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

module.exports = { getSettings, getByKey, updateSettings };
