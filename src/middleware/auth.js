const { verifyAccessToken, createRefreshToken, setTokenCookies } = require('../utils/jwt');
const { getPrisma } = require('../database');

function authenticate(req, res, next) {
  const token = req.cookies?.access_token;
  if (!token) return res.status(401).json({ error: 'Unauthorized', message: 'No access token provided' });
  try {
    const decoded = verifyAccessToken(token);
    req.user = { id: decoded.sub, role: decoded.role, email: decoded.email };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return refreshAndRetry(req, res, next);
    }
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid access token' });
  }
}

async function refreshAndRetry(req, res, next) {
  const refreshToken = req.cookies?.refresh_token;
  if (!refreshToken) return res.status(401).json({ error: 'Unauthorized', message: 'No refresh token provided' });
  try {
    const { verifyRefreshToken, rotateRefreshToken } = require('../utils/jwt');
    const decoded = verifyRefreshToken(refreshToken);
    const prisma = getPrisma();
    const stored = await prisma.refreshToken.findUnique({
      where: { token: refreshToken }
    });
    if (!stored || stored.revoked || stored.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Refresh token expired or revoked' });
    }
    const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
    if (!user) return res.status(401).json({ error: 'Unauthorized', message: 'User not found' });
    const newRefreshToken = await rotateRefreshToken(refreshToken, user.id);
    const { signAccessToken } = require('../utils/jwt');
    const accessToken = signAccessToken({ sub: user.id, role: user.role, email: user.email });
    setTokenCookies(res, accessToken, newRefreshToken);
    req.user = { id: user.id, role: user.role, email: user.email };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid refresh token' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized', message: 'Not authenticated' });
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Insufficient permissions' });
    }
    next();
  };
}

function optionalAuth(req, res, next) {
  const token = req.cookies?.access_token;
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const decoded = verifyAccessToken(token);
    req.user = { id: decoded.sub, role: decoded.role, email: decoded.email };
  } catch {
    req.user = null;
  }
  next();
}

module.exports = { authenticate, authorize, optionalAuth };
