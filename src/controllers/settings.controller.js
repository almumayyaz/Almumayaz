const { settingService } = require('../services');

function actorId(req) {
  return req.user?.id || req.session?.user?.id;
}

async function getSettings(req, res) {
  const settings = await settingService.getSettings();
  res.json(settings);
}

async function getByKey(req, res) {
  const result = await settingService.getByKey(req.params.key);
  if (!result) return res.status(404).json({ error: 'الإعداد غير موجود' });
  res.json(result);
}

async function updateSettings(req, res) {
  const settings = await settingService.updateSettings({ ...req.body, _ip: req.headers['x-forwarded-for'] || req.ip, _ua: req.headers['user-agent'] }, actorId(req));
  res.json({ success: true, settings });
}

module.exports = { getSettings, getByKey, updateSettings };
