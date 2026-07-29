const { getClient } = require('./client');
const { readSettings, readScheduledNotifications, readZoomAppCredentials } = require('./legacy-reader');
const { safeDate, safeString, newCuid } = require('./utils');
const MigrationLogger = require('./logger');

async function migrateConfig({ dryRun = false } = {}) {
  const prisma = getClient();
  const logger = new MigrationLogger(dryRun);

  if (dryRun) {
    const settings = readSettings();
    const snots = readScheduledNotifications();
    const zoom = readZoomAppCredentials();
    const settingKeys = Object.keys(settings).length;
    logger.start('Setting');
    logger.read('Setting', settingKeys);
    logger.done('Setting', 0, settingKeys);
    logger.start('ZoomAppCredential');
    const zoomCount = zoom.clientId ? 1 : 0;
    logger.read('ZoomAppCredential', zoomCount);
    logger.done('ZoomAppCredential', 0, zoomCount);
    logger.start('ScheduledNotification');
    logger.read('ScheduledNotification', snots.length);
    logger.done('ScheduledNotification', 0, snots.length);
    return logger.report();
  }

  logger.start('Setting');
  logger.start('ZoomAppCredential');
  logger.start('ScheduledNotification');

  // ── SETTINGS ──
  const settingsRaw = readSettings();
  const settingKeys = Object.keys(settingsRaw);
  logger.read('Setting', settingKeys.length);

  let settingCreated = 0;
  let settingSkipped = 0;

  for (const key of settingKeys) {
    try {
      const existing = await prisma.setting.findUnique({ where: { key } });
      if (existing) {
        settingSkipped++;
        continue;
      }
      if (dryRun) { settingCreated++; continue; }
      await prisma.setting.create({
        data: { key, value: settingsRaw[key] },
      });
      settingCreated++;
    } catch (e) {
      logger.logFailed('Setting', key, e);
    }
  }
  logger.found('Setting', settingKeys.length);
  logger.done('Setting', settingCreated, settingSkipped);

  // ── ZOOM APP CREDENTIALS ──
  const zoomRaw = readZoomAppCredentials();
  const hasZoom = zoomRaw.clientId ? 1 : 0;
  logger.read('ZoomAppCredential', hasZoom);

  let zoomCreated = 0;
  let zoomSkipped = 0;

  if (hasZoom) {
    try {
      const existingZoom = await prisma.zoomAppCredential.findFirst();
      if (existingZoom) {
        zoomSkipped++;
      } else if (!dryRun) {
        await prisma.zoomAppCredential.create({
          data: {
            clientId: zoomRaw.clientId,
            clientSecret: zoomRaw.clientSecret,
            redirectUri: zoomRaw.redirectUri,
            sdkKey: zoomRaw.sdkKey || null,
            sdkSecret: zoomRaw.sdkSecret || null,
          },
        });
        zoomCreated++;
      } else {
        zoomCreated++;
      }
    } catch (e) {
      logger.logFailed('ZoomAppCredential', 'singleton', e);
    }
  }
  logger.found('ZoomAppCredential', hasZoom);
  logger.done('ZoomAppCredential', zoomCreated, zoomSkipped);

  // ── SCHEDULED NOTIFICATIONS ──
  const snotsRaw = readScheduledNotifications();
  logger.read('ScheduledNotification', snotsRaw.length);

  let snotCreated = 0;
  let snotSkipped = 0;

  for (const sn of snotsRaw) {
    if (!sn.id) {
      snotSkipped++;
      continue;
    }
    try {
      const existing = await prisma.scheduledNotification.findFirst({
        where: { title: sn.title, scheduledAt: safeDate(sn.scheduledAt) || new Date() },
      });
      if (existing) {
        snotSkipped++;
        continue;
      }
      if (dryRun) { snotCreated++; continue; }
      await prisma.scheduledNotification.create({
        data: {
          id: newCuid(),
          title: safeString(sn.title),
          body: safeString(sn.body),
          url: safeString(sn.url),
          role: safeString(sn.role),
          target: safeString(sn.target),
          targetValue: safeString(sn.targetValue),
          scheduledAt: safeDate(sn.scheduledAt) || new Date(),
          sent: sn.status === 'Sent' || !!sn.sentAt || false,
          createdAt: safeDate(sn.createdAt) || new Date(),
        },
      });
      snotCreated++;
    } catch (e) {
      logger.logFailed('ScheduledNotification', sn.id, e);
    }
  }
  logger.found('ScheduledNotification', snotsRaw.length);
  logger.done('ScheduledNotification', snotCreated, snotSkipped);

  const dbSettingCount = await prisma.setting.count();
  const dbZoomCount = await prisma.zoomAppCredential.count();
  const dbSnotCount = await prisma.scheduledNotification.count();

  return {
    report: logger.report(),
    summary: logger.summary(),
    legacySettings: settingKeys.length,
    dbSettings: dbSettingCount,
    settingCreated,
    settingSkipped,
    legacyZoom: hasZoom,
    dbZoom: dbZoomCount,
    zoomCreated,
    zoomSkipped,
    legacySnots: snotsRaw.length,
    dbSnots: dbSnotCount,
    snotCreated,
    snotSkipped,
  };
}

async function dryRunConfig() {
  return migrateConfig({ dryRun: true });
}

module.exports = { migrateConfig, dryRunConfig };
