/**
 * 简单的内存存储 (生产环境请替换为 Redis + 数据库)
 */

// 用户存储 Map<userId, userObject>
const users = new Map();

// 验证码存储 Map<key, {code, expire, attempts}>
const otpStore = new Map();

// OAuth state 防 CSRF Map<state, {provider, expire}>
const oauthStates = new Map();

// 工具函数
const store = {
  // ========== 用户操作 ==========
  findUserByEmail(email) {
    for (const user of users.values()) {
      if (user.email === email) return user;
    }
    return null;
  },

  findUserByPhone(phone) {
    for (const user of users.values()) {
      if (user.phone === phone) return user;
    }
    return null;
  },

  findUserByOAuth(provider, openId) {
    for (const user of users.values()) {
      if (user.oauth?.[provider] === openId) return user;
    }
    return null;
  },

  findUserById(id) {
    return users.get(id) || null;
  },

  createUser(userData) {
    const user = {
      id: userData.id,
      name: userData.name || '',
      email: userData.email || null,
      phone: userData.phone || null,
      avatar: userData.avatar || null,
      oauth: userData.oauth || {},
      passwordHash: userData.passwordHash || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    users.set(user.id, user);
    return user;
  },

  updateUser(id, updates) {
    const user = users.get(id);
    if (!user) return null;
    const updated = { ...user, ...updates, updatedAt: new Date().toISOString() };
    users.set(id, updated);
    return updated;
  },

  // ========== 验证码操作 ==========
  setOTP(key, code, expireSeconds) {
    otpStore.set(key, {
      code,
      expire: Date.now() + expireSeconds * 1000,
      attempts: 0,
    });
  },

  verifyOTP(key, code) {
    const entry = otpStore.get(key);
    if (!entry) return { valid: false, reason: 'not_found' };
    if (Date.now() > entry.expire) {
      otpStore.delete(key);
      return { valid: false, reason: 'expired' };
    }
    entry.attempts += 1;
    if (entry.attempts > 5) return { valid: false, reason: 'too_many_attempts' };
    if (entry.code !== code) return { valid: false, reason: 'wrong_code' };
    otpStore.delete(key);
    return { valid: true };
  },

  // ========== OAuth State 操作 ==========
  setOAuthState(state, data) {
    oauthStates.set(state, { ...data, expire: Date.now() + 10 * 60 * 1000 });
    // 清理过期 state
    for (const [k, v] of oauthStates.entries()) {
      if (Date.now() > v.expire) oauthStates.delete(k);
    }
  },

  getOAuthState(state) {
    const entry = oauthStates.get(state);
    if (!entry) return null;
    if (Date.now() > entry.expire) {
      oauthStates.delete(state);
      return null;
    }
    oauthStates.delete(state);
    return entry;
  },
};

module.exports = store;
