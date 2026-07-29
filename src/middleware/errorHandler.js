function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.expose || err.status ? err.message : 'Internal server error';
  if (status >= 500) {
    console.error(`[ERROR] ${req.method} ${req.path}:`, err);
  }
  res.status(status).json({ error: code, message });
}

module.exports = { errorHandler };
