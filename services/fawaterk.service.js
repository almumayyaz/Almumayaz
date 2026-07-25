const crypto = require('crypto');
const https = require('https');

const BASE_URL = 'https://app.fawaterk.com/api/v2';

function getApiKey() {
  return process.env.FAWATERK_CLIENT_ID || '';
}

function getSecret() {
  return process.env.FAWATERK_CLIENT_SECRET || '';
}

function isEnabled() {
  return !!(getApiKey() && getSecret());
}

function apiRequest(path, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getApiKey(),
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function verifyWebhookHash(body, signature) {
  if (!signature) return false;
  const secret = getSecret();
  const computed = crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
  return computed === signature;
}

function parseWebhookEvent(body) {
  const status = body.status || body.event || '';
  return {
    depositRef: body.deposit_ref || body.customer_ref || body.customerRef || '',
    status: status,
    event: body.event || status,
    transactionId: body.transaction_id || body.transactionId || body.id || '',
    amount: body.amount || body.total || 0
  };
}

async function createTransaction({ customerRef, depositId, amount, customerName, customerEmail, customerPhone, successUrl, failUrl, pendingUrl }) {
  const payload = {
    customer_ref: customerRef,
    deposit_id: depositId,
    amount: amount,
    customer: {
      name: customerName,
      email: customerEmail,
      phone: customerPhone
    },
    success_url: successUrl,
    fail_url: failUrl,
    pending_url: pendingUrl,
    payment_methods: ['card', 'wallet', 'bank_transfer'],
    currency: 'EGP'
  };
  const result = await apiRequest('/create-invoice', 'POST', payload);
  return {
    intentKey: result && (result.intentKey || result.intent_key || ''),
    transactionId: result && (result.transactionId || result.transaction_id || result.id || ''),
    paymentUrl: result && (result.paymentUrl || result.payment_url || result.url || result.invoice_url || '')
  };
}

module.exports = { isEnabled, verifyWebhookHash, parseWebhookEvent, createTransaction };
