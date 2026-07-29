const { userService } = require('../services');
const { setTokenCookies, clearTokenCookies } = require('../utils/jwt');

async function register(req, res) {
  const result = await userService.register(req.body);
  if (result.conflict) return res.status(409).json({ error: 'CONFLICT', message: 'Email already registered' });
  setTokenCookies(res, result.accessToken, result.refreshToken);
  res.status(201).json({ user: { id: result.user.id, name: result.user.name, email: result.user.email, role: result.user.role } });
}

async function login(req, res) {
  const result = await userService.login(req.body);
  if (result.unauthorized) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid email or password' });
  setTokenCookies(res, result.accessToken, result.refreshToken);
  res.json({ user: { id: result.user.id, name: result.user.name, email: result.user.email, role: result.user.role } });
}

async function logout(req, res) {
  await userService.logout(req.cookies?.refresh_token);
  clearTokenCookies(res);
  res.json({ message: 'Logged out' });
}

async function refresh(req, res) {
  const oldToken = req.cookies?.refresh_token;
  if (!oldToken) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'No refresh token' });
  const result = await userService.refreshTokens(oldToken);
  if (result.unauthorized) {
    if (result.expired) clearTokenCookies(res);
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Refresh token expired or revoked' });
  }
  setTokenCookies(res, result.accessToken, result.refreshToken);
  res.json({ user: { id: result.user.id, name: result.user.name, email: result.user.email, role: result.user.role } });
}

async function me(req, res) {
  const user = await userService.me(req.user.id);
  if (!user) return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' });
  res.json({ user });
}

module.exports = { register, login, logout, refresh, me };
