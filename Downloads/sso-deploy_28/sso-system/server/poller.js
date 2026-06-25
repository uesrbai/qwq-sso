/**
 * 服务商轮询选择器
 * 策略：least（最少调用优先）| sequential（顺序优先）
 */
const db = require('./db');

/**
 * 读取轮询策略
 * @param {'sms'|'email'|'kyc'} type
 */
function getStrategy(type) {
  const row = db.prepare("SELECT value FROM shop_config WHERE key_name=?").get(`${type}_poll_strategy`);
  return row?.value || 'least';
}

/**
 * 获取某类型的调用统计
 */
function getStats(provider) {
  return db.prepare("SELECT * FROM provider_stats WHERE provider=?").get(provider)
    || { provider, call_count: 0, fail_count: 0, last_used: null };
}

/**
 * 记录调用结果
 * @param {string} provider 服务商标识，如 'sms_volcengine'
 * @param {boolean} success
 */
function recordCall(provider, success) {
  db.prepare(`
    INSERT INTO provider_stats (provider, call_count, fail_count, last_used, updated_at)
    VALUES (?, 1, ?, datetime('now'), datetime('now'))
    ON CONFLICT(provider) DO UPDATE SET
      call_count = call_count + 1,
      fail_count = fail_count + ?,
      last_used  = datetime('now'),
      updated_at = datetime('now')
  `).run(provider, success ? 0 : 1, success ? 0 : 1);
}

/**
 * 从可用服务商列表中按策略选出调用顺序
 * @param {Array<{key: string, available: boolean}>} providers 按优先顺序排列的服务商列表
 * @param {string} strategy 'least' | 'sequential'
 * @returns {Array} 可用服务商，按选择顺序排列（第一个是本次首选）
 */
function selectProviders(providers, strategy) {
  const available = providers.filter(p => p.available);
  if (!available.length) return [];

  if (strategy === 'sequential') {
    return available; // 顺序优先：直接按传入顺序
  }

  // least：按调用次数升序，最少调用的优先
  return available.slice().sort((a, b) => {
    const sa = getStats(a.key).call_count;
    const sb = getStats(b.key).call_count;
    return sa - sb;
  });
}

/**
 * 带自动故障转移的轮询执行
 * @param {Array<{key:string,available:boolean,fn:Function}>} providers 每个含 fn()=Promise 的服务商
 * @param {string} strategy
 * @returns {Promise<{provider:string, result:any}>}
 */
async function pollExecute(providers, strategy) {
  const ordered = selectProviders(providers, strategy);
  if (!ordered.length) throw new Error('无可用服务商，请检查配置');

  let lastErr;
  for (const p of ordered) {
    try {
      const result = await p.fn();
      recordCall(p.key, true);
      return { provider: p.key, result };
    } catch (err) {
      recordCall(p.key, false);
      lastErr = err;
      console.warn(`[Poller] ${p.key} 失败，尝试下一个: ${err.message}`);
    }
  }
  throw lastErr || new Error('所有服务商均失败');
}

/**
 * 获取所有服务商的调用统计（用于管理端展示）
 */
function getAllStats() {
  return db.prepare("SELECT * FROM provider_stats ORDER BY call_count DESC").all();
}

/**
 * 重置某服务商统计
 */
function resetStats(provider) {
  db.prepare("DELETE FROM provider_stats WHERE provider=?").run(provider);
}

module.exports = { getStrategy, selectProviders, pollExecute, recordCall, getAllStats, resetStats };
