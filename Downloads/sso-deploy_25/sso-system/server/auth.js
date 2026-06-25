/**
 * JWT 签发与鉴权中间件
 */
const jwt = require('jsonwebtoken');

function getSecret() {
  return process.env.JWT_SECRET || 'dev-secret-CHANGE-IN-PRODUCTION';
}

function signToken(payload) {
  return jwt.sign(payload, getSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function verifyToken(token) {
  try {
    return { valid: true, data: jwt.verify(token, getSecret()) };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录或 Token 缺失' });
  }
  const { valid, data, error } = verifyToken(auth.slice(7));
  if (!valid) return res.status(401).json({ error: `Token 无效: ${error}` });
  req.user = data;
  next();
}

function requireAdmin(level = 3) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
      }
      if ((req.user.adminLevel || 99) > level) {
        return res.status(403).json({ error: `需要管理员 Lv.${level} 或更高` });
      }
      next();
    });
  };
}

function requireApiKey(scope) {
  return async (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'API Key 缺失' });
    }
    const token = auth.slice(7);
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const { apiKeys } = require('./db');
    const key = apiKeys.findByHash.get(hash, 'active');
    if (!key) return res.status(401).json({ error: 'API Key 无效或已撤销' });
    const scopes = JSON.parse(key.scopes || '[]');
    if (scope && !scopes.includes(scope)) {
      return res.status(403).json({ error: `权限不足，需要 scope: ${scope}` });
    }
    apiKeys.touch.run(key.id);
    req.apiKey = key;
    next();
  };
}

module.exports = { signToken, verifyToken, requireAuth, requireAdmin, requireApiKey };
