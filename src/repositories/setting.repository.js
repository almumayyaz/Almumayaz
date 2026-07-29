const BaseRepository = require('./_base');

class SettingRepository extends BaseRepository {
  constructor() {
    super('settings');
  }

  async getGeneral() {
    const doc = await this.get('general');
    if (doc) return doc;
    return this.create({ id: 'general' });
  }

  async updateSetting(key, value, userId) {
    const settings = await this.getGeneral();
    return this.update('general', { [key]: value }, userId);
  }

  async getSemester() {
    const settings = await this.getGeneral();
    return (settings && settings.currentSemester) || 'all';
  }

  async getContactInfo() {
    const settings = await this.getGeneral();
    if (!settings) return {};
    return {
      phone: settings.contactPhone || '',
      email: settings.contactEmail || '',
      address: settings.contactAddress || '',
      whatsapp: settings.contactWhatsapp || ''
    };
  }
}

module.exports = SettingRepository;
