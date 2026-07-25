const { BrevoClient } = require('@getbrevo/brevo');
const usageTracker = require('./usage-tracker');

const RETRY_MAX = 3;
const TIMEOUT_MS = 10000;
const FROM_EMAIL = process.env.BREVO_SENDER_EMAIL || 'noreply@almumayaz.online';
const FROM_NAME = 'المميز | Almumayaz';

class EmailService {
  constructor() {
    this.client = null;
    this.ready = false;
    this._init();
  }

  _init() {
    var apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
      console.error('[EmailService] BREVO_API_KEY not configured — emails will not be sent');
      return;
    }
    this.client = new BrevoClient({ apiKey: apiKey });
    this.ready = true;
  }

  _sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  async _sendWithRetry(to, subject, html, text) {
    if (!this.ready) {
      console.error('[EmailService] not ready (no BREVO_API_KEY)');
      return false;
    }
    for (var attempt = 1; attempt <= RETRY_MAX; attempt++) {
      try {
        var result = await this._sendSingle(to, subject, html, text);
        console.log('[EmailService] Sent OK to ' + to + ' | messageId: ' + (result.data && result.data.messageId ? result.data.messageId : 'unknown'));
        usageTracker.track('brevo', 'sendMail');
        return true;
      } catch (err) {
        console.error('[EmailService] Attempt ' + attempt + '/' + RETRY_MAX + ' failed for ' + to + ': ' + (err.message || err));
        if (attempt === RETRY_MAX) {
          console.error('[EmailService] All attempts exhausted for ' + to);
          return false;
        }
        await this._sleep(1000 * Math.pow(2, attempt));
      }
    }
    return false;
  }

  async _sendSingle(to, subject, html, text) {
    var timeoutPromise = new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('Timeout after ' + TIMEOUT_MS + 'ms')); }, TIMEOUT_MS);
    });
    var sendPromise = this.client.transactionalEmails.sendTransacEmail({
      htmlContent: html,
      textContent: text || html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\n+/g, '\n').trim(),
      sender: { email: FROM_EMAIL, name: FROM_NAME },
      subject: subject,
      to: [{ email: to, name: '.' }]
    });
    return await Promise.race([sendPromise, timeoutPromise]);
  }

  async sendMail(to, subject, html, text) {
    return await this._sendWithRetry(to, subject, html, text);
  }

  async sendMailDebug(to, subject, html, text) {
    if (!this.ready) return { sent: false, error: 'BREVO_API_KEY not configured' };
    for (var attempt = 1; attempt <= RETRY_MAX; attempt++) {
      try {
        var result = await this._sendSingle(to, subject, html, text);
        return { sent: true, messageId: result.data && result.data.messageId ? result.data.messageId : 'unknown' };
      } catch (err) {
        var detail = err.body ? (err.body.message || JSON.stringify(err.body)) : (err.message || String(err));
        if (err.statusCode) detail = '[HTTP ' + err.statusCode + '] ' + detail;
        if (attempt === RETRY_MAX) return { sent: false, error: detail, attempts: attempt };
        await this._sleep(1000 * Math.pow(2, attempt));
      }
    }
    return { sent: false, error: 'unknown' };
  }

  async sendVerificationEmail(to, name, code) {
    var html = this._verifyEmailHtml(name || 'طالب', code);
    var text = 'مرحباً ' + (name || 'طالب') + '،\n\nنشكرك على انضمامك إلى منصة المُميز! نحن سعداء بانضمامك.\n\nلتفعيل حسابك، يرجى إدخال كود التأكيد التالي:\n' + code + '\n\nصالح لمدة 30 دقيقة.\n\nهذه الرسالة مرسلة بشكل آلي، يرجى عدم الرد.';
    return await this._sendWithRetry(to, 'كود تأكيد البريد الإلكتروني - منصة المُميز', html, text);
  }

  async sendResetPasswordEmail(to, name, code) {
    var html = this._resetEmailHtml(name || 'طالب', code);
    var text = 'مرحباً ' + (name || 'طالب') + '،\n\nلقد تلقينا طلباً لإعادة تعيين كلمة المرور الخاصة بحسابك في منصة المُميز.\nإذا كنت أنت من أرسل هذا الطلب، استخدم الكود التالي:\n' + code + '\n\nصالح لمدة 30 دقيقة.\n\nإذا لم تقم بهذا الطلب، تجاهل هذه الرسالة.\n\nهذه الرسالة مرسلة بشكل آلي، يرجى عدم الرد.';
    return await this._sendWithRetry(to, 'إعادة تعيين كلمة المرور - منصة المُميز', html, text);
  }

  _emailShell(title, bodyHtml) {
    return '<!DOCTYPE html>\n<html dir="rtl">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>\n<body style="margin:0;padding:0;background:#f4f4f6;font-family:Tahoma,\'Segoe UI\',Arial,sans-serif;">\n<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:32px 12px;">\n<tr><td align="center">\n<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">\n<tr><td style="padding:32px 24px 24px;text-align:center;background:linear-gradient(135deg,#0f1b34 0%,#1a2d50 100%);">\n<img src="https://almumayaz.online/icon-192.png" alt="المميز" width="64" height="64" style="border-radius:12px;display:block;margin:0 auto;">\n<div style="color:#F59E0B;font-size:28px;font-weight:bold;margin-top:10px;letter-spacing:2px;">منصة المُميز</div>\n<div style="color:#FBBF24;font-size:12px;margin-top:4px;">Almumayaz Educational Platform</div>\n<div style="width:50px;height:3px;background:linear-gradient(90deg,#F59E0B,#FBBF24);border-radius:2px;margin:16px auto 0;"></div>\n<div style="color:#fde68a;font-size:15px;margin-top:16px;font-weight:600;">' + title + '</div>\n</td></tr>\n<tr><td style="padding:36px 28px 28px;font-size:15px;line-height:1.9;color:#374151;">\n' + bodyHtml + '\n</td></tr>\n<tr><td style="padding:20px 28px;text-align:center;background:#fafafa;border-top:1px solid #eee;">\n<p style="font-size:11px;color:#aaa;margin:0 0 4px;">منصة المُميز للتعليم &mdash; Almumayaz</p>\n<p style="font-size:10px;color:#ccc;margin:0;">هذه الرسالة مرسلة بشكل آلي، يرجى عدم الرد.</p>\n</td></tr>\n</table>\n<p style="font-size:11px;color:#ccc;text-align:center;margin:12px 0 0;">&copy; ' + new Date().getFullYear() + ' Almumayaz. جميع الحقوق محفوظة.</p>\n</td></tr></table></body></html>';
  }

  _verifyEmailHtml(name, code) {
    return this._emailShell('تأكيد البريد الإلكتروني',
      '<p style="margin:0 0 20px;font-size:17px;">مرحباً <strong>' + name + '،</strong></p>\n<p style="margin:0 0 6px;color:#666;">نشكرك على انضمامك إلى منصة المُميز! نحن سعداء بانضمامك.</p>\n<p style="margin:0 0 28px;color:#666;">لتفعيل حسابك، يرجى إدخال كود التأكيد التالي:</p>\n<div style="text-align:center;margin:0 0 28px;">\n<div style="display:inline-block;padding:16px 36px;background:linear-gradient(135deg,#fffbeb,#fef3c7);border:2px solid #f59e0b;border-radius:12px;font-size:38px;font-weight:bold;color:#d97706;letter-spacing:12px;direction:ltr;font-family:monospace;box-shadow:0 2px 12px rgba(217,119,6,0.15);">' + code + '</div>\n</div>\n<p style="text-align:center;font-size:13px;color:#999;margin:0;"><span style="background:#fef3c7;padding:4px 12px;border-radius:4px;color:#d97706;">صالح لمدة 30 دقيقة</span></p>');
  }

  _resetEmailHtml(name, code) {
    return this._emailShell('إعادة تعيين كلمة المرور',
      '<p style="margin:0 0 20px;font-size:17px;">مرحباً <strong>' + name + '،</strong></p>\n<p style="margin:0 0 6px;color:#666;">لقد تلقينا طلباً لإعادة تعيين كلمة المرور الخاصة بحسابك في منصة المُميز.</p>\n<p style="margin:0 0 28px;color:#666;">إذا كنت أنت من أرسل هذا الطلب، استخدم الكود التالي:</p>\n<div style="text-align:center;margin:0 0 28px;">\n<div style="display:inline-block;padding:16px 36px;background:linear-gradient(135deg,#fffbeb,#fef3c7);border:2px solid #f59e0b;border-radius:12px;font-size:38px;font-weight:bold;color:#d97706;letter-spacing:12px;direction:ltr;font-family:monospace;box-shadow:0 2px 12px rgba(217,119,6,0.15);">' + code + '</div>\n</div>\n<p style="text-align:center;font-size:13px;color:#999;margin:0;"><span style="background:#fef3c7;padding:4px 12px;border-radius:4px;color:#d97706;">صالح لمدة 30 دقيقة</span></p>');
  }

  subscriptionEmailHtml(studentName, phone, planName, price) {
    return this._emailShell('طلب اشتراك جديد',
      '<p style="margin:0 0 20px;font-size:17px;">طلب اشتراك جديد من <strong>' + studentName + '</strong></p>\n<p style="margin:0 0 6px;color:#666;"><strong>الطالب:</strong> ' + studentName + '</p>\n<p style="margin:0 0 6px;color:#666;"><strong>الهاتف:</strong> ' + phone + '</p>\n<p style="margin:0 0 6px;color:#666;"><strong>الباقة:</strong> ' + planName + '</p>\n<p style="margin:0 0 24px;color:#666;"><strong>المبلغ:</strong> ' + price + ' جنيه</p>\n<div style="text-align:center;margin:0 0 24px;">\n<a href="https://almumayaz.online/admin/sub-requests" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#0f1b34,#1a2d50);color:#fbbf24;text-decoration:none;border-radius:8px;font-size:16px;font-weight:bold;">عرض الطلب</a>\n</div>');
  }

  inviteEmailHtml(parentName, studentName, inviteLink) {
    return this._emailShell('دعوة ولي الأمر',
      '<p style="margin:0 0 20px;font-size:17px;">مرحباً <strong>' + parentName + '،</strong></p>\n<p style="margin:0 0 6px;color:#666;">الطالب <strong>' + studentName + '</strong> يدعوك لمتابعة مسيرته التعليمية على منصة المُميز.</p>\n<p style="margin:0 0 24px;color:#666;">اضغط على الرابط أدناه لإنشاء حساب ولي الأمر:</p>\n<div style="text-align:center;margin:0 0 24px;">\n<a href="' + inviteLink + '" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#0f1b34,#1a2d50);color:#fbbf24;text-decoration:none;border-radius:8px;font-size:16px;font-weight:bold;">إنشاء حساب ولي الأمر</a>\n</div>\n<p style="text-align:center;font-size:11px;color:#999;">أو انسخ الرابط: ' + inviteLink + '</p>');
  }
}

module.exports = new EmailService();
