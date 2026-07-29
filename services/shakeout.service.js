const https = require('https');
const crypto = require('crypto');
const { readData, writeData } = require('../prisma-bridge');

const API_BASE = 'https://dash.shake-out.com/api/public/vendor';
const API_KEY = process.env.SHAKEOUT_API_KEY || '';
const SECRET_KEY = process.env.SHAKEOUT_SECRET_KEY || '';
const APP_URL = process.env.APP_URL || 'https://almumayaz.online';

function log(level, label, msg, data) {
  var ts = new Date().toISOString();
  var prefix = '[ShakeOut][' + level + '][' + label + ']';
  if (data) console.log(ts + ' ' + prefix + ' ' + msg, typeof data === 'object' ? JSON.stringify(data).slice(0, 500) : data);
  else console.log(ts + ' ' + prefix + ' ' + msg);
}
var logger = { debug: function(l, m, d) { log('DEBUG', l, m, d); }, info: function(l, m, d) { log('INFO', l, m, d); }, warn: function(l, m, d) { log('WARN', l, m, d); }, error: function(l, m, d) { log('ERROR', l, m, d); } };

function isConfigured() {
  return !!(API_KEY && SECRET_KEY);
}

function httpsRequest(url, method, headers, body, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var parsed = new URL(url);
    var opts = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + (parsed.search || ''),
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      timeout: timeoutMs || 15000,
    };
    var req = https.request(opts, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var parsed = JSON.parse(data);
          if (res.statusCode >= 400 && parsed && parsed.error) reject(new Error(parsed.message || parsed.error));
          else resolve(parsed);
        } catch (e) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function normalizeCurrency(cur) {
  if (!cur) return 'EGP';
  var c = String(cur).trim().toUpperCase();
  var map = { 'EGP': 'EGP', 'جنيه': 'EGP', 'ج.م': 'EGP', 'جنية': 'EGP', 'USD': 'USD', 'US': 'USD', '$': 'USD' };
  return map[c] || 'EGP';
}

async function createInvoice(studentId, studentName, studentEmail, studentPhone, plan, subscriptionId) {
  if (!isConfigured()) throw new Error('Shake Out is not configured');
  logger.info('createInvoice', 'Creating invoice for student ' + studentId + ', plan ' + plan.name);

  var tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  var payload = {
    amount: parseInt(plan.price) || 0,
    currency: normalizeCurrency(plan.currency),
    customer: {
      first_name: studentName || 'طالب',
      last_name: '_',
      email: studentEmail || 'student@almumayaz.online',
      phone: (studentPhone || '').replace(/[^0-9+]/g, '') || '000000000000',
      address: 'N/A',
    },
    invoice_items: [
      { name: 'اشتراك ' + plan.name + ' - المُميز', price: parseInt(plan.price) || 0, quantity: 1 }
    ],
    due_date: tomorrow,
    redirection_urls: {
      success_url: APP_URL + '/student/shakeout-redirect?status=success',
      fail_url: APP_URL + '/student/shakeout-redirect?status=fail',
      pending_url: APP_URL + '/student/shakeout-redirect?status=pending',
    },
  };

  var headers = { Authorization: 'apikey ' + API_KEY };
  logger.info('createInvoice', 'Sending payload', payload);

  var res;
  try {
    res = await httpsRequest(API_BASE + '/invoice', 'POST', headers, payload, 20000);
  } catch (e) {
    logger.error('createInvoice', 'API request failed', e.message);
    throw new Error(e.message);
  }
  logger.info('createInvoice', 'API response', res);

  if (!res || res.status !== 'success' || !res.data || !res.data.url) {
    logger.error('createInvoice', 'Invalid response', res);
    if (res && res.errors) {
      var details = Object.keys(res.errors).map(function(k) { return k + ': ' + res.errors[k].join(', '); }).join('; ');
      throw new Error((res.message || 'خطأ في البيانات') + ': ' + details);
    }
    throw new Error(res && res.message ? res.message : 'استجابة غير صالحة من بوابة الدفع');
  }

  var invoice = {
    invoiceId: res.data.invoice_id,
    invoiceRef: res.data.invoice_ref || '',
    studentId: studentId,
    planName: plan.name,
    subscriptionId: subscriptionId || '',
    amount: parseInt(plan.price) || 0,
    currency: normalizeCurrency(plan.currency),
    status: 'pending',
    paymentUrl: res.data.url,
    type: 'shakeout',
    durationDays: plan.durationDays || 30,
    planStage: plan.stage || '',
    period: plan.period || '',
    createdAt: new Date().toISOString(),
  };

  var payments = await readData('subscriptionPayments') || [];
  if (!Array.isArray(payments)) payments = Object.values(payments);
  payments.push(invoice);
  await writeData('subscriptionPayments', payments);
  logger.info('createInvoice', 'Invoice created, id=' + invoice.invoiceId + ', url=' + invoice.paymentUrl);
  return invoice;
}

function verifySignature(data, signature) {
  if (!signature) {
    logger.warn('verifySignature', 'No signature provided');
    return false;
  }
  try {
    var raw = data.invoice_id + (data.amount || '') + (data.invoice_status || '') + (data.updated_at || '') + SECRET_KEY;
    var computed = crypto.createHash('sha256').update(raw).digest('hex');
    var match = computed === signature;
    if (!match) logger.error('verifySignature', 'Signature mismatch');
    else logger.info('verifySignature', 'Signature valid');
    return match;
  } catch (e) {
    logger.error('verifySignature', 'Verification error', e.message);
    return false;
  }
}

async function handleWebhook(body) {
  if (!body || !body.type || !body.data || !body.signature) {
    logger.warn('handleWebhook', 'Missing webhook fields');
    throw Object.assign(new Error('بيانات ناقصة'), { statusCode: 400 });
  }
  logger.info('handleWebhook', 'Webhook received, type=' + body.type + ', invoice=' + (body.data.invoice_id || ''));

  var data = body.data;
  var signature = body.signature;

  if (!verifySignature(data, signature)) {
    logger.error('handleWebhook', 'Signature invalid');
    throw Object.assign(new Error('توقيع غير صالح'), { statusCode: 401 });
  }
  logger.info('handleWebhook', 'Signature valid');

  var invoiceStatus = data.invoice_status;
  var invoiceId = data.invoice_id;

  // Find and update invoice in subscriptionPayments
  var payments = await readData('subscriptionPayments') || [];
  if (!Array.isArray(payments)) payments = Object.values(payments);
  var pIdx = payments.findIndex(function(p) { return p.invoiceId === invoiceId; });
  if (pIdx === -1) {
    logger.error('handleWebhook', 'Invoice not found: ' + invoiceId);
    throw Object.assign(new Error('الفاتورة غير موجودة'), { statusCode: 404 });
  }

  var updated = {
    status: invoiceStatus,
    paymentMethod: data.payment_method || '',
    referenceNumber: data.reference_number || '',
    invoiceRef: data.invoice_ref || payments[pIdx].invoiceRef,
    updatedAt: new Date().toISOString()
  };
  Object.keys(updated).forEach(function(k) { payments[pIdx][k] = updated[k]; });

  if (invoiceStatus === 'paid') {
    logger.info('handleWebhook', 'Payment paid, activating subscription for invoice ' + invoiceId);

    // Activate student subscription
    var users = await readData('users') || [];
    if (!Array.isArray(users)) users = Object.values(users);
    var uIdx = users.findIndex(function(u) { return u.id === payments[pIdx].studentId || u.uid === payments[pIdx].studentId; });
    if (uIdx !== -1) {
      users[uIdx].subscriptionStatus = 'active';
      users[uIdx].subscriptionStart = new Date().toISOString();
      var dur = payments[pIdx].durationDays || 30;
      users[uIdx].subscriptionEnd = new Date(Date.now() + dur * 86400000).toISOString();
      users[uIdx].planName = payments[pIdx].planName;
      users[uIdx].planPeriod = payments[pIdx].period || '';
      await writeData('users', users);
      logger.info('handleWebhook', 'Subscription activated for user ' + payments[pIdx].studentId);

      // Record payment in payments collection
      try {
        var allPayments = await readData('payments') || [];
        allPayments.push({
          id: 'PAY-' + Date.now(),
          userId: payments[pIdx].studentId,
          userName: users[uIdx].name || '',
          transactionId: payments[pIdx].invoiceRef || payments[pIdx].invoiceId || '',
          amount: Number(payments[pIdx].amount) || 0,
          method: 'shakeout',
          planName: payments[pIdx].planName || '',
          status: 'approved',
          date: new Date().toISOString(),
          rejectReason: ''
        });
        await writeData('payments', allPayments);
        logger.info('handleWebhook', 'Payment recorded for user ' + payments[pIdx].studentId);
      } catch (pe) { logger.error('handleWebhook', 'Failed to record payment', pe.message); }

      // Notify all admins via FCM
      try {
        var admins = users.filter(function(u) { return u.role === 'admin' && u.fcmToken; });
        var { sendFCM, sendFCMToRole } = require('../prisma-bridge');
        for (var ai = 0; ai < admins.length; ai++) {
          try {
            await sendFCM(admins[ai].id, '💳 اشتراك جديد عبر Shake Out', 'اشترك ' + (users[uIdx].name || 'طالب') + ' في خطة ' + (payments[pIdx].planName || '') + ' بمبلغ ' + (payments[pIdx].amount || 0) + ' جنيه', '/admin/payments');
          } catch (fe) { logger.error('handleWebhook', 'FCM error for admin ' + admins[ai].id, fe.message); }
        }
      } catch (ne) { logger.error('handleWebhook', 'Admin notify error', ne.message); }
    } else {
      logger.error('handleWebhook', 'User not found: ' + payments[pIdx].studentId);
    }
  }

  if (invoiceStatus === 'paid' || invoiceStatus === 'pending' || invoiceStatus === 'expired' || invoiceStatus === 'failed') {
    await writeData('subscriptionPayments', payments);
    logger.info('handleWebhook', 'Invoice ' + invoiceId + ' updated to ' + invoiceStatus);
  }

  return { success: true, status: invoiceStatus };
}

module.exports = { isConfigured, createInvoice, verifySignature, handleWebhook };
