const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getPrisma } = require('../database');

const ACCESS_SECRET = process.env.JWT_SECRET || 'change-me-dev-access';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'change-me-dev-refresh';
const ACCESS_EXPIRY = process.env.JWT_ACCESS_EXPIRY || '15m';
const REFRESH_EXPIRY = process.env.JWT_REFRESH_EXPIRY || '7d';

function signAccessToken(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRY });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_EXPIRY });
}

function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

function generateTokenId() {
  return crypto.randomBytes(24).toString('hex');
}

function parseExpiry(expiryStr) {
  const match = expiryStr.match(/^(\d+)([smhd])$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const val = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return val * 1000;
    case 'm': return val * 60 * 1000;
    case 'h': return val * 3600 * 1000;
    case 'd': return val * 86400 * 1000;
    default: return 7 * 86400 * 1000;
  }
}

async function createRefreshToken(userId) {
  const prisma = getPrisma();
  const tokenId = generateTokenId();
  const expiresAt = new Date(Date.now() + parseExpiry(REFRESH_EXPIRY));
  const refreshToken = signRefreshToken({ jti: tokenId, sub: userId });
  await prisma.refreshToken.create({
    data: { id: tokenId, userId, token: refreshToken, expiresAt }
  });
  return refreshToken;
}

async function rotateRefreshToken(oldToken, userId) {
  const prisma = getPrisma();
  await prisma.refreshToken.updateMany({
    where: { token: oldToken, userId, revoked: false },
    data: { revoked: true }
  });
  return createRefreshToken(userId);
}

async function revokeRefreshToken(token) {
  const prisma = getPrisma();
  await prisma.refreshToken.updateMany({
    where: { token, revoked: false },
    data: { revoked: true }
  });
}

async function revokeAllUserTokens(userId) {
  const prisma = getPrisma();
  await prisma.refreshToken.updateMany({
    where: { userId, revoked: false },
    data: { revoked: true }
  });
}

function setTokenCookies(res, accessToken, refreshToken) {
  const isSecure = process.env.NODE_ENV === 'production';
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    maxAge: parseExpiry(ACCESS_EXPIRY),
    path: '/',
  });
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    maxAge: parseExpiry(REFRESH_EXPIRY),
    path: '/api/auth',
  });
}

function clearTokenCookies(res) {
  res.clearCookie('access_token', { path: '/' });
  res.clearCookie('refresh_token', { path: '/api/auth' });
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  createRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  setTokenCookies,
  clearTokenCookies,
};
