const TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 10000;

async function withTimeout(promise, label, ms) {
  const timeoutMs = ms || TIMEOUT_MS;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`[${label}] Request timed out after ${timeoutMs}ms`);
      err.name = 'TimeoutError';
      err.statusCode = 504;
      reject(err);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timer);
    return result;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function timeoutMiddleware(req, res, next) {
  const timeoutMs = TIMEOUT_MS;
  res.setTimeout(timeoutMs, () => {
    console.error(`[Timeout] Request ${req.method} ${req.path} timed out after ${timeoutMs}ms`);
    if (!res.headersSent) {
      res.status(504).json({ error: 'Gateway Timeout', message: 'استغرقت العملية وقتًا طويلاً، حاول مرة أخرى.' });
    }
  });
  next();
}

module.exports = { withTimeout, timeoutMiddleware, TIMEOUT_MS };
