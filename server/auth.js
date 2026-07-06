/**
 * JWT 签发与鉴权中间件
 */
const jwt = require('jsonwebtoken');

function getSecret() {
  return process.env.JWT_SECRET || 'dev-secret-CHANGE-IN-PRODUCTION';
}

function signToken(payload) {
  let expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  // 验证 expiresIn 格式：数字（秒）或带单位字符串（7d, 24h, 3600s 等）
  // 如果是纯数字且 <= 60，说明可能配置错了（单位混淆），强制用 7d
  const asNum = parseInt(expiresIn);
  if (!isNaN(asNum) && asNum <= 60) {
    console.warn(`[JWT] JWT_EXPIRES_IN="${expiresIn}" 疑似配置错误（太短），已强制使用 7d`);
    expiresIn = '7d';
  }
  return jwt.sign(payload, getSecret(), { expiresIn });
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

    if (!token.startsWith('sk_live_') && !token.startsWith('sk_test_')) {
      return res.status(401).json({ error: 'API Key 格式无效' });
    }
    const isTestKey = token.startsWith('sk_test_');

    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const { apiKeys } = require('./db');
    const key = apiKeys.findByHash.get(hash, 'active');
    if (!key) return res.status(401).json({ error: 'API Key 无效或已撤销' });

    // 可信 IP 检查：
    // - 实际密钥：必须配置可信 IP 且在范围内
    // - 测试密钥：默认不校验 IP；仅当用户主动配置了具体 IP（非 * 非空）才校验
    const clientIp = req.ip?.replace('::ffff:', '') || '';
    if (!isTestKey) {
      if (!key.trusted_ips || key.trusted_ips === '*') {
        return res.status(403).json({ error: '该 API Key 未配置可信 IP，无法调用' });
      }
      const allowedIps = key.trusted_ips.split(',').map(s => s.trim()).filter(Boolean);
      if (!allowedIps.includes(clientIp)) {
        return res.status(403).json({ error: `IP ${clientIp} 不在可信范围内` });
      }
    } else {
      // 测试密钥：仅当明确配置了 IP 列表才校验
      if (key.trusted_ips && key.trusted_ips !== '*' && key.trusted_ips.trim()) {
        const allowedIps = key.trusted_ips.split(',').map(s => s.trim()).filter(Boolean);
        if (allowedIps.length && !allowedIps.includes(clientIp)) {
          return res.status(403).json({ error: `IP ${clientIp} 不在测试密钥指定范围内` });
        }
      }
    }

    const scopes = JSON.parse(key.scopes || '[]');
    if (scope && !scopes.includes(scope)) {
      return res.status(403).json({ error: `权限不足，需要 scope: ${scope}` });
    }
    apiKeys.touch.run(key.id);
    req.apiKey = key;
    req.isSandbox = isTestKey; // 沙盒标记：测试密钥不返回真实数据
    next();
  };
}

module.exports = { signToken, verifyToken, requireAuth, requireAdmin, requireApiKey };
