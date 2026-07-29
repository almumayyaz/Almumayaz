const { userRepo, settingRepo } = require('../repositories');

async function applyReferral(uid, { code }) {
  if (!code || !code.startsWith('REF-')) return { invalidCode: true };

  const referrer = await userRepo.findFirst({ referralCode: code });
  if (!referrer) return { notFound: true };
  if (referrer.id === uid) return { selfReferral: true };

  const user = await userRepo.get(uid);
  if (!user) return { userNotFound: true };
  if (user.referralDiscount > 0) return { alreadyUsed: true };
  if (user.referralUsedAt) {
    const daysSince = (Date.now() - new Date(user.referralUsedAt).getTime()) / 86400000;
    if (daysSince < 30) {
      const daysLeft = 30 - Math.floor(daysSince);
      return { cooldown: true, daysLeft };
    }
  }

  const settings = await settingRepo.findBy('key', 'referralDiscount');
  const refDiscount = settings ? parseFloat(settings.value) || 25 : 25;

  await userRepo.update(uid, { referralDiscount: refDiscount, referredBy: referrer.referralCode, referralUsedAt: new Date() });

  const currentReferrals = typeof referrer.referrals === 'string' ? JSON.parse(referrer.referrals) : (Array.isArray(referrer.referrals) ? referrer.referrals : []);
  currentReferrals.push({ userId: uid, discount: refDiscount, date: new Date().toISOString() });
  await userRepo.update(referrer.id, { referrals: currentReferrals });

  return { success: true, discount: refDiscount, message: 'تم تطبيق خصم ' + refDiscount + '% على جميع خطط الاشتراك!' };
}

module.exports = { applyReferral };
