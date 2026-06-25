/**
 * API 路由 - 所有业务接口
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db, nextUidSeq, users, oauth, otp, logs, apps, apiKeys, env, points } = require('./db');
const { signToken, requireAuth, requireAdmin, requireApiKey } = require('./auth');
const { sendSmsCode } = require('./sms');
const { sendEmailCode } = require('./email');

const router = express.Router();
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isPhone = s => /^1[3-9]\d{9}$/.test(s);
const genCode = () => String(Math.floor(100000 + Math.random() * 900000));

function logLogin(data) {
  try {
    logs.insert.run({
      id: uuidv4(), user_id: data.userId||null, user_name: data.userName||null,
      uid_seq: data.uidSeq||null, method: data.method,
      app_name: data.appName||'本系统', ip: data.ip||null,
      user_agent: data.ua||null, status: data.status||'success',
      fail_reason: data.failReason||null,
    });
  } catch(_) {}
}

function safeUser(u) {
  if (!u) return null;
  const { password_hash, ...safe } = u;
  return safe;
}

// ── 短信验证码 ──
router.post('/sms/send', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !isPhone(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  const code = genCode();
  const expire = parseInt(process.env.SMS_CODE_EXPIRE || '300');
  otp.clean.run(Date.now());
  otp.set.run(`sms:${phone}`, code, Date.now() + expire * 1000);
  if (process.env.NODE_ENV !== 'production') { console.log(`[DEV SMS] ${phone} → ${code}`); }
  else { try { await sendSmsCode(phone, code); } catch (e) { return res.status(500).json({ error: '短信发送失败' }); } }
  res.json({ success: true, expires: expire });
});

router.post('/sms/verify', (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: '参数缺失' });
  const entry = otp.get.get(`sms:${phone}`);
  if (!entry || Date.now() > entry.expire_at) { otp.del.run(`sms:${phone}`); return res.status(400).json({ error: '验证码不存在或已过期' }); }
  otp.incAtt.run(`sms:${phone}`);
  if (entry.attempts >= 5) return res.status(400).json({ error: '错误次数过多，请重新获取' });
  if (entry.code !== code) return res.status(400).json({ error: '验证码错误' });
  otp.del.run(`sms:${phone}`);
  let user = users.findByPhone.get(phone);
  if (!user) {
    const seq = nextUidSeq(); const id = uuidv4();
    users.insert.run({ id, uid_seq: seq, name: `用户${phone.slice(-4)}`, email: null, phone, password_hash: null, role: 'user', admin_level: null, user_level: 4, status: 'active' });
    user = users.findById.get(id);
  }
  if (user.status === 'disabled') return res.status(403).json({ error: '账号已停用，请联系管理员' });
  logLogin({ userId: user.id, userName: user.name, uidSeq: String(user.uid_seq), method: '短信验证码', ip: req.ip, ua: req.headers['user-agent'] });
  const token = signToken({ uid: user.id, name: user.name, role: user.role, adminLevel: user.admin_level });
  res.json({ success: true, token, user: safeUser(user) });
});

// ── 邮箱验证码 ──
router.post('/email/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email || !isEmail(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  const code = genCode(); const expire = parseInt(process.env.EMAIL_CODE_EXPIRE || '600');
  otp.set.run(`email:${email}`, code, Date.now() + expire * 1000);
  if (process.env.NODE_ENV !== 'production') { console.log(`[DEV EMAIL] ${email} → ${code}`); }
  else { try { await sendEmailCode(email, code); } catch (e) { return res.status(500).json({ error: '邮件发送失败' }); } }
  res.json({ success: true, expires: expire });
});

router.post('/email/verify-code', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: '参数缺失' });
  const entry = otp.get.get(`email:${email}`);
  if (!entry || Date.now() > entry.expire_at) { otp.del.run(`email:${email}`); return res.status(400).json({ error: '验证码不存在或已过期' }); }
  otp.incAtt.run(`email:${email}`);
  if (entry.attempts >= 5) return res.status(400).json({ error: '错误次数过多' });
  if (entry.code !== code) return res.status(400).json({ error: '验证码错误' });
  otp.del.run(`email:${email}`);
  let user = users.findByEmail.get(email);
  if (!user) {
    const seq = nextUidSeq(); const id = uuidv4();
    users.insert.run({ id, uid_seq: seq, name: email.split('@')[0], email, phone: null, password_hash: null, role: 'user', admin_level: null, user_level: 4, status: 'active' });
    user = users.findById.get(id);
  }
  if (user.status === 'disabled') return res.status(403).json({ error: '账号已停用' });
  logLogin({ userId: user.id, userName: user.name, uidSeq: String(user.uid_seq), method: '邮箱验证码', ip: req.ip, ua: req.headers['user-agent'] });
  const token = signToken({ uid: user.id, name: user.name, role: user.role, adminLevel: user.admin_level });
  res.json({ success: true, token, user: safeUser(user) });
});

// ── 邮箱密码 ──
router.post('/email/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !isEmail(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  if (users.findByEmail.get(email)) return res.status(400).json({ error: '该邮箱已注册' });
  const hash = await bcrypt.hash(password, 10); const seq = nextUidSeq(); const id = uuidv4();
  users.insert.run({ id, uid_seq: seq, name: name || email.split('@')[0], email, phone: null, password_hash: hash, role: 'user', admin_level: null, user_level: 4, status: 'active' });
  const user = users.findById.get(id);
  const token = signToken({ uid: user.id, name: user.name, role: user.role, adminLevel: user.admin_level });
  res.json({ success: true, token, user: safeUser(user) });
});

router.post('/email/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: '请输入邮箱和密码' });
  const user = users.findByEmail.get(email);
  if (!user || !user.password_hash) { logLogin({ method: '邮箱密码', ip: req.ip, ua: req.headers['user-agent'], status: 'failed', failReason: '账号不存在' }); return res.status(401).json({ error: '邮箱或密码不正确' }); }
  if (user.status === 'disabled') { logLogin({ userId: user.id, method: '邮箱密码', ip: req.ip, ua: req.headers['user-agent'], status: 'disabled' }); return res.status(403).json({ error: '账号已停用，请联系管理员' }); }
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) { logLogin({ userId: user.id, userName: user.name, uidSeq: String(user.uid_seq), method: '邮箱密码', ip: req.ip, ua: req.headers['user-agent'], status: 'failed', failReason: '密码错误' }); return res.status(401).json({ error: '邮箱或密码不正确' }); }
  logLogin({ userId: user.id, userName: user.name, uidSeq: String(user.uid_seq), method: '邮箱密码', ip: req.ip, ua: req.headers['user-agent'] });
  const token = signToken({ uid: user.id, name: user.name, role: user.role, adminLevel: user.admin_level });
  res.json({ success: true, token, user: safeUser(user) });
});

// ── 用户信息 ──
// ── KYC 实名认证接口 ──
const { createKycSession, verifyKycDirect, verifyDiditWebhook, verifyStripeWebhook } = require('./kyc');

// 用户端：发起 KYC 认证（会话跳转模式 - Didit / Stripe）
router.post('/user/kyc/session', requireAuth, async (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.kyc_verified) return res.status(400).json({ error: '已完成实名认证' });

  try {
    const callbackUrl = `${process.env.BASE_URL || ''}/auth/kyc/callback?user_id=${user.id}`;
    const { result } = await createKycSession(user.id, callbackUrl);
    res.json({ success: true, redirect_url: result.redirect_url, provider: result.provider, session_id: result.session_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 用户端：直接认证（阿里云/火山引擎，提交姓名+身份证）
router.post('/user/kyc/direct', requireAuth, async (req, res) => {
  const { name, id_number } = req.body;
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.kyc_verified) return res.status(400).json({ error: '已完成实名认证' });
  if (!name?.trim() || !id_number?.trim()) return res.status(400).json({ error: '姓名和身份证号为必填' });

  try {
    await verifyKycDirect(name.trim(), id_number.trim());
    // 写入认证结果
    const idTail = id_number.slice(-4);
    const maskedName = name.length <= 2 ? name[0] + '*' : name[0] + '*'.repeat(name.length - 2) + name.slice(-1);
    db.prepare("UPDATE users SET kyc_verified=1, kyc_name=?, kyc_id_tail=?, kyc_provider=?, updated_at=datetime('now') WHERE id=?")
      .run(maskedName, idTail, '服务商直接认证', user.id);
    res.json({ success: true, message: '实名认证成功' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Webhook 回调：Didit 认证结果
router.post('/webhook/kyc/didit', express.raw({ type: '*/*' }), (req, res) => {
  const sig    = req.headers['x-didit-signature'] || req.headers['x-webhook-signature'] || '';
  const secret = process.env.DIDIT_WEBHOOK_SECRET;
  if (secret && sig && !verifyDiditWebhook(req.body, sig, secret)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  try {
    const payload = JSON.parse(req.body.toString());
    const userId  = payload.vendor_data || payload.session?.vendor_data;
    const status  = payload.status;
    if (userId && (status === 'Approved' || status === 'approved')) {
      const user = users.findById.get(userId);
      if (user && !user.kyc_verified) {
        const docData = payload.kyc_result?.id_verification || {};
        const name    = docData.full_name || '';
        const idNum   = docData.document_number || '';
        const maskedName = name.length <= 2 ? name[0] + '*' : name[0] + '*'.repeat(name.length - 2) + name.slice(-1);
        db.prepare("UPDATE users SET kyc_verified=1, kyc_name=?, kyc_id_tail=?, kyc_provider=? WHERE id=?")
          .run(maskedName || '—', idNum.slice(-4) || '—', 'Didit', userId);
      }
    }
    recordCall('kyc_didit', status === 'Approved' || status === 'approved');
  } catch (_) {}
  res.json({ received: true });
});

// Webhook 回调：Stripe Identity 认证结果
router.post('/webhook/kyc/stripe', express.raw({ type: '*/*' }), (req, res) => {
  const sig    = req.headers['stripe-signature'] || '';
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (secret && sig && !verifyStripeWebhook(req.body.toString(), sig, secret)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  try {
    const event   = JSON.parse(req.body.toString());
    const session = event.data?.object;
    const userId  = session?.metadata?.user_id;
    if (userId && event.type === 'identity.verification_session.verified') {
      const user = users.findById.get(userId);
      if (user && !user.kyc_verified) {
        const outputs = session.verified_outputs || {};
        const name    = outputs.name ? `${outputs.name.last_name || ''}${outputs.name.first_name || ''}` : '';
        const idNum   = outputs.id_number || outputs.document?.number || '';
        const maskedName = name.length <= 2 ? (name[0] || '—') + '*' : name[0] + '*'.repeat(name.length - 2) + name.slice(-1);
        db.prepare("UPDATE users SET kyc_verified=1, kyc_name=?, kyc_id_tail=?, kyc_provider=? WHERE id=?")
          .run(maskedName || '—', idNum.slice(-4) || '—', 'Stripe Identity', userId);
      }
      recordCall('kyc_stripe', true);
    } else if (event.type === 'identity.verification_session.requires_input') {
      recordCall('kyc_stripe', false);
    }
  } catch (_) {}
  res.json({ received: true });
});

// KYC 认证完成跳转页（用户完成 Didit/Stripe 后跳回）
router.get('/auth/kyc/callback', (req, res) => {
  const { user_id, status } = req.query;
  const success = status === 'Approved' || status === 'verified';
  res.redirect(`/dashboard.html?kyc_result=${success ? 'success' : 'pending'}&user_id=${user_id}`);
});
const { getAllStats, resetStats } = require('./poller');

router.get('/admin/provider-stats', requireAdmin(2), (req, res) => {
  res.json({ success: true, stats: getAllStats() });
});

router.delete('/admin/provider-stats/:provider', requireAdmin(2), (req, res) => {
  resetStats(decodeURIComponent(req.params.provider));
  res.json({ success: true });
});

// ── 公开接口：已配置的登录平台（无需鉴权）──
router.get('/public/configured-platforms', (req, res) => {
  // 各平台对应的必须环境变量 key
  const platformEnvKeys = {
    wechat:      'WECHAT_APP_ID',
    wecom:       'WECOM_CORP_ID',
    feishu:      'FEISHU_APP_ID',
    dingtalk:    'DINGTALK_CLIENT_ID',
    douyin:      'DOUYIN_CLIENT_KEY',
    kuaishou:    'KUAISHOU_APP_ID',
    xiaohongshu: 'XHS_CLIENT_ID',
    bilibili:    'BILIBILI_CLIENT_ID',
    google:      'GOOGLE_CLIENT_ID',
    apple:       'APPLE_CLIENT_ID',
    github:      'GITHUB_CLIENT_ID',
    microsoft:   'MICROSOFT_CLIENT_ID',
    qq:          'QQ_APP_ID',
  };
  const configured = [];
  for (const [platform, envKey] of Object.entries(platformEnvKeys)) {
    // 先查数据库，再查进程环境变量
    const row = env.get.get(envKey);
    const val = row?.value || process.env[envKey];
    if (val && val.trim()) configured.push(platform);
  }
  // 如果一个都没配置，默认显示微信+企业微信
  if (configured.length === 0) configured.push('wechat', 'wecom');
  res.json({ success: true, platforms: configured });
});

router.get('/user/me', requireAuth, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const oauthBinds = oauth.findByUser.all(user.id);
  res.json({ success: true, user: { ...safeUser(user), oauthBinds } });
});

router.post('/user/profile', requireAuth, (req, res) => {
  const { name, phone, timezone } = req.body;
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (phone && phone !== user.phone && users.findByPhone.get(phone)) return res.status(400).json({ error: '该手机号已被占用' });
  const updates = [];
  const vals = [];
  if (name)     { updates.push("name=?");     vals.push(name); }
  if (phone)    { updates.push("phone=?");    vals.push(phone); }
  if (timezone) { updates.push("timezone=?"); vals.push(timezone); }
  if (updates.length) {
    vals.push(user.id);
    db.prepare(`UPDATE users SET ${updates.join(',')},updated_at=datetime('now') WHERE id=?`).run(...vals);
  }
  res.json({ success: true });
});

// ── 用户端：获取积分日志 ──
router.get('/user/points-history', requireAuth, (req, res) => {
  const logs = db.prepare('SELECT * FROM points_log WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.uid);
  res.json({ success: true, logs });
});

// ── 用户端：重置密码（邮箱/手机验证码）──
router.post('/user/reset-password', requireAuth, async (req, res) => {
  const { new_password, code, via } = req.body; // via: 'email' | 'sms'
  if (!new_password || new_password.length < 8) return res.status(400).json({ error: '新密码至少 8 位' });
  if (!code) return res.status(400).json({ error: '请提供验证码' });

  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 验证 OTP
  const target = via === 'email' ? user.email : user.phone;
  if (!target) return res.status(400).json({ error: `账号未绑定${via === 'email' ? '邮箱' : '手机'}，无法通过此方式验证` });

  const otpRow = db.prepare("SELECT * FROM otp_store WHERE target=? AND code=? AND used=0 AND expires_at>datetime('now')").get(target, code);
  if (!otpRow) return res.status(400).json({ error: '验证码错误或已过期' });
  db.prepare("UPDATE otp_store SET used=1 WHERE id=?").run(otpRow.id);

  const hash = await bcrypt.hash(new_password, 12);
  db.prepare("UPDATE users SET password_hash=?,updated_at=datetime('now') WHERE id=?").run(hash, user.id);
  res.json({ success: true, message: '密码已重置' });
});

// ── 用户端：用户时区设置 ──
router.get('/user/timezone', requireAuth, (req, res) => {
  const user = users.findById.get(req.user.uid);
  res.json({ success: true, timezone: user?.timezone || 'auto' });
});

router.post('/user/checkin', requireAuth, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const today = new Date().toISOString().slice(0,10);
  if (user.last_checkin === today) return res.status(400).json({ error: '今日已签到' });
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
  if (user.last_checkin === yesterday) users.checkin.run(user.id);
  else users.resetStreak.run(user.id);
  const pts = 10;
  users.addPoints.run(pts, user.id);
  points.insert.run(uuidv4(), user.id, pts, '每日签到');
  const updated = users.findById.get(user.id);
  res.json({ success: true, points: pts, streak: updated.checkin_streak, total: updated.points });
});

router.delete('/user/kyc', requireAuth, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user || !user.kyc_verified) return res.status(400).json({ error: '未实名认证' });
  users.clearKyc.run(user.id);
  res.json({ success: true });
});

router.delete('/user/oauth/:provider', requireAuth, (req, res) => {
  oauth.unbind.run(req.user.uid, req.params.provider);
  res.json({ success: true });
});

router.get('/user/login-logs', requireAuth, (req, res) => {
  res.json({ success: true, logs: logs.findByUser.all(req.user.uid, 20) });
});

router.get('/user/points-log', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM points_log WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.uid);
  res.json({ success: true, logs: rows });
});

// ── 应用市场（用户端）──
router.get('/apps/market', requireAuth, (req, res) => {
  const list = apps.findEnabled.all();
  res.json({ success: true, apps: list.map(a => ({ ...a, userAuthed: !!apps.isAuthed.get(req.user.uid, a.id) })) });
});
router.post('/apps/:id/auth', requireAuth, (req, res) => {
  const app = apps.findById.get(req.params.id);
  if (!app || app.status !== 'enabled') return res.status(404).json({ error: '应用不存在' });
  if (!apps.isAuthed.get(req.user.uid, app.id)) { apps.authUser.run(req.user.uid, app.id); apps.incAuthUsers.run(app.id); }
  res.json({ success: true });
});
router.delete('/apps/:id/auth', requireAuth, (req, res) => {
  apps.revokeAuth.run(req.user.uid, req.params.id);
  apps.decAuthUsers.run(req.params.id);
  res.json({ success: true });
});
router.get('/apps/authed', requireAuth, (req, res) => {
  res.json({ success: true, apps: apps.getUserApps.all(req.user.uid) });
});

// ── SSO 验证 ──
router.post('/auth/verify', requireAuth, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(401).json({ valid: false });
  res.json({ valid: true, user: safeUser(user) });
});

// ── 管理端 ──
router.get('/admin/stats', requireAdmin(3), (req, res) => {
  const total = users.countAll.get().n;
  const verified = users.countVerified.get().n;
  const todayActive = users.countActive.get().n;
  const newThisMonth = db.prepare("SELECT COUNT(*) as n FROM users WHERE strftime('%Y-%m',created_at)=strftime('%Y-%m','now')").get().n;
  const daily7 = db.prepare("SELECT date(created_at) as d,COUNT(*) as n FROM users WHERE date(created_at)>=date('now','-6 days') GROUP BY d ORDER BY d ASC").all();
  res.json({ success: true, stats: { total, verified, todayActive, newThisMonth, daily7 } });
});

router.get('/admin/users', requireAdmin(3), (req, res) => {
  const { status, q } = req.query;
  let rows;
  if (q) {
    // 支持 UID（纯数字）、昵称、邮箱、手机、组织搜索
    const isUid = /^\d+$/.test(q.trim());
    if (isUid) {
      rows = db.prepare("SELECT * FROM users WHERE uid_seq=? OR name LIKE ? OR email LIKE ? OR phone LIKE ? ORDER BY uid_seq")
        .all(parseInt(q), `%${q}%`, `%${q}%`, `%${q}%`);
    } else {
      rows = db.prepare("SELECT * FROM users WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? OR organization LIKE ? ORDER BY uid_seq")
        .all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
  } else if (status) {
    rows = users.findByStatus.all(status);
  } else {
    rows = users.findAll.all();
  }
  res.json({ success: true, users: rows.map(safeUser) });
});

router.get('/admin/users/:id', requireAdmin(3), (req, res) => {
  const user = users.findById.get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ success: true, user: { ...safeUser(user), oauthBinds: oauth.findByUser.all(user.id), apps: apps.getUserApps.all(user.id), loginLogs: logs.findByUser.all(user.id, 10) } });
});

router.patch('/admin/users/:id', requireAdmin(2), (req, res) => {
  const { name, email, phone, status, user_level, admin_level } = req.body;
  db.prepare("UPDATE users SET name=COALESCE(?,name),email=COALESCE(?,email),phone=COALESCE(?,phone),status=COALESCE(?,status),user_level=COALESCE(?,user_level),admin_level=COALESCE(?,admin_level),updated_at=datetime('now') WHERE id=?")
    .run(name,email,phone,status,user_level,admin_level,req.params.id);
  res.json({ success: true });
});

// ── 管理端：新建用户 ──
router.post('/admin/users', requireAdmin(2), async (req, res) => {
  const { name, email, password, phone, role = 'user', user_level = 4 } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: '用户名、邮箱、密码为必填' });
  if (password.length < 8) return res.status(400).json({ error: '密码至少 8 位' });
  const existing = users.findByEmail.get(email);
  if (existing) return res.status(400).json({ error: '该邮箱已被注册' });
  const nameExists = db.prepare('SELECT 1 FROM users WHERE name=?').get(name);
  if (nameExists) return res.status(400).json({ error: '该用户名已存在' });
  const hash = await bcrypt.hash(password, 12);
  const seq  = nextUidSeq();
  const id   = uuidv4();
  users.insert.run({ id, uid_seq: seq, name, email, phone: phone||null, password_hash: hash, role, admin_level: role==='admin'?2:null, user_level: parseInt(user_level)||4, status: 'active' });
  res.json({ success: true, id, uid_seq: seq });
});

router.post('/admin/users/:id/disable', requireAdmin(2), (req, res) => {
  const target = users.findById.get(req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  // 不能停用自己
  if (target.id === req.user.uid) return res.status(403).json({ error: '不能停用自己的账号' });
  // 管理员不能停用同级或更高级别管理员
  const operator = users.findById.get(req.user.uid);
  if (target.role === 'admin' && operator.role === 'admin') {
    if ((target.admin_level || 99) <= (operator.admin_level || 99)) {
      return res.status(403).json({ error: `无法停用同级或更高级别的管理员（对方 Lv.${target.admin_level}）` });
    }
  }
  db.prepare("UPDATE users SET status='disabled',updated_at=datetime('now') WHERE id=?").run(target.id);
  res.json({ success: true });
});
router.post('/admin/users/:id/enable', requireAdmin(2), (req, res) => {
  db.prepare("UPDATE users SET status='active',updated_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ success: true });
});
router.post('/admin/users/:id/reset-password', requireAdmin(2), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  users.updatePassword.run(await bcrypt.hash(password, 10), req.params.id);
  res.json({ success: true });
});
router.delete('/admin/users/:id/kyc', requireAdmin(2), (req, res) => {
  users.clearKyc.run(req.params.id); res.json({ success: true });
});
router.get('/admin/users/:id/logs', requireAdmin(3), (req, res) => {
  res.json({ success: true, logs: logs.findByUser.all(req.params.id, 50) });
});

router.get('/admin/apps', requireAdmin(3), (req, res) => { res.json({ success: true, apps: apps.findAll.all() }); });
router.post('/admin/apps', requireAdmin(2), (req, res) => {
  const { name, icon='📦', icon_bg='#F0F0F0', description='', callback_url, visible=false } = req.body;
  if (!name || !callback_url) return res.status(400).json({ error: '名称和回调地址必填' });
  const id = uuidv4();
  const client_id = 'app_' + crypto.randomBytes(6).toString('hex');
  const client_secret = crypto.randomBytes(32).toString('hex');
  apps.insert.run({ id, name, icon, icon_bg, description, client_id, client_secret, callback_url, status:'pending', visible: visible?1:0 });
  res.json({ success: true, app: apps.findById.get(id) });
});
router.patch('/admin/apps/:id', requireAdmin(2), (req, res) => {
  const app = apps.findById.get(req.params.id);
  if (!app) return res.status(404).json({ error: '应用不存在' });
  const { name, icon, icon_bg, description, callback_url, status, visible } = req.body;
  apps.update.run({ id: app.id, name:name??app.name, icon:icon??app.icon, icon_bg:icon_bg??app.icon_bg, description:description??app.description, callback_url:callback_url??app.callback_url, status:status??app.status, visible:visible!==undefined?(visible?1:0):app.visible });
  res.json({ success: true, app: apps.findById.get(app.id) });
});
router.post('/admin/apps/:id/approve', requireAdmin(2), (req, res) => {
  apps.approve.run(req.params.id); res.json({ success: true });
});

router.post('/admin/apps/:id/reject', requireAdmin(2), (req, res) => {
  const { reason } = req.body;
  db.prepare("UPDATE apps SET status='rejected',updated_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

router.delete('/admin/apps/:id', requireAdmin(2), (req, res) => {
  db.prepare('DELETE FROM user_app_auth WHERE app_id=?').run(req.params.id);
  db.prepare('DELETE FROM apps WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.get('/admin/logs', requireAdmin(3), (req, res) => { res.json({ success: true, logs: logs.findAll.all() }); });

router.get('/admin/api-keys', requireAdmin(1), (req, res) => { res.json({ success: true, keys: apiKeys.findAll.all() }); });
router.post('/admin/api-keys', requireAdmin(1), (req, res) => {
  const { name, scopes=[] } = req.body;
  if (!name) return res.status(400).json({ error: '密钥名称必填' });
  const token = 'sk-live-' + crypto.randomBytes(20).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const id = uuidv4();
  apiKeys.insert.run({ id, name, token_hash: hash, token_prefix: token.slice(0,18), scopes: JSON.stringify(scopes), status:'active', created_by: req.user.uid });
  res.json({ success: true, token });
});
router.delete('/admin/api-keys/:id', requireAdmin(1), (req, res) => {
  apiKeys.revoke.run(req.params.id); res.json({ success: true });
});

router.get('/admin/env', requireAdmin(1), (req, res) => {
  const rows = env.getAll.all(); const map = {};
  rows.forEach(r => { map[r.key_name] = r.value; });
  res.json({ success: true, env: map });
});
router.post('/admin/env', requireAdmin(1), (req, res) => {
  const { vars } = req.body;
  if (!vars || typeof vars !== 'object') return res.status(400).json({ error: '参数错误' });
  Object.entries(vars).forEach(([k, v]) => env.set.run(k, v));
  res.json({ success: true });
});

// ── 开放 API（第三方 API Key 调用）──
router.get('/v1/auth/verify', requireApiKey('auth:verify'), (req, res) => {
  const token = req.headers['x-user-token'];
  if (!token) return res.status(400).json({ error: 'x-user-token 请求头缺失' });
  const { verifyToken } = require('./auth');
  const { valid, data } = verifyToken(token);
  if (!valid) return res.status(401).json({ valid: false });
  const user = users.findById.get(data.uid);
  if (!user) return res.status(401).json({ valid: false });
  res.json({ valid: true, user: safeUser(user) });
});
router.get('/v1/users', requireApiKey('users:read'), (req, res) => {
  const { status, page=1, limit=20 } = req.query;
  const lim = Math.min(parseInt(limit),100); const off = (parseInt(page)-1)*lim;
  const rows = status
    ? db.prepare('SELECT * FROM users WHERE status=? LIMIT ? OFFSET ?').all(status,lim,off)
    : db.prepare('SELECT * FROM users LIMIT ? OFFSET ?').all(lim,off);
  res.json({ total: users.countAll.get().n, page: parseInt(page), data: rows.map(safeUser) });
});
router.get('/v1/users/:uid', requireApiKey('users:read'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE uid_seq=? OR id=?').get(req.params.uid, req.params.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json(safeUser(user));
});
router.post('/v1/users/:uid/disable', requireApiKey('users:write'), (req, res) => {
  db.prepare("UPDATE users SET status='disabled' WHERE uid_seq=? OR id=?").run(req.params.uid,req.params.uid);
  res.json({ success: true });
});
router.post('/v1/users/:uid/enable', requireApiKey('users:write'), (req, res) => {
  db.prepare("UPDATE users SET status='active' WHERE uid_seq=? OR id=?").run(req.params.uid,req.params.uid);
  res.json({ success: true });
});
router.delete('/v1/users/:uid/realname', requireApiKey('users:kyc'), (req, res) => {
  db.prepare("UPDATE users SET kyc_verified=0,kyc_name=NULL,kyc_id_tail=NULL WHERE uid_seq=? OR id=?").run(req.params.uid,req.params.uid);
  res.json({ success: true });
});
router.get('/v1/apps', requireApiKey('apps:read'), (req, res) => {
  res.json({ total: apps.findAll.all().length, data: apps.findAll.all() });
});
router.post('/v1/sms/send', requireApiKey('sms:send'), async (req, res) => {
  const { phone } = req.body;
  if (!phone || !isPhone(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  try { const code = genCode(); await sendSmsCode(phone, code); res.json({ success: true, msgId: 'sms_'+Date.now() }); }
  catch (e) { res.status(500).json({ error: '短信发送失败' }); }
});
router.get('/v1/logs', requireApiKey('logs:read'), (req, res) => {
  const rows = logs.findAll.all(); res.json({ total: rows.length, data: rows });
});

// ──────────────────────────────────────────
// 积分商城 - 建表
// ──────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS shop_goods (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    icon           TEXT NOT NULL DEFAULT '🎁',
    description    TEXT NOT NULL DEFAULT '',
    note           TEXT,
    cost           INTEGER NOT NULL DEFAULT 100,
    stock          INTEGER NOT NULL DEFAULT -1,
    exchange_count INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'on',
    sort_weight    INTEGER NOT NULL DEFAULT 0,
    -- 兑换码发放模式
    redeem_mode    TEXT NOT NULL DEFAULT 'code',    -- code=兑换码发放 | direct=直接到账
    allow_instant  INTEGER NOT NULL DEFAULT 1,       -- 是否允许当场兑换
    redirect_url   TEXT,                             -- 当场兑换跳转地址
    allow_transfer INTEGER NOT NULL DEFAULT 1,       -- 是否允许转送他人
    transfer_fee   INTEGER NOT NULL DEFAULT 0,       -- 转送扣除积分
    allow_discard  INTEGER NOT NULL DEFAULT 1,       -- 是否允许丢弃
    is_blind_box   INTEGER NOT NULL DEFAULT 0,       -- 是否为盲盒
    open_instantly INTEGER NOT NULL DEFAULT 1,       -- 盲盒是否当场打开
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 盲盒奖励配置
  CREATE TABLE IF NOT EXISTS blind_box_rewards (
    id          TEXT PRIMARY KEY,
    goods_id    TEXT NOT NULL REFERENCES shop_goods(id) ON DELETE CASCADE,
    type        TEXT NOT NULL DEFAULT 'points',  -- points | deduct_points | goods | redeem_code | nothing
    value       INTEGER,                          -- 积分数量（正负）
    goods_ref   TEXT,                             -- 关联商品 ID（type=goods）
    label       TEXT NOT NULL DEFAULT '神秘奖励', -- 前端显示名称
    weight      INTEGER NOT NULL DEFAULT 10,      -- 概率权重
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 用户持有的兑换券（商品兑换后生成）
  CREATE TABLE IF NOT EXISTS user_coupons (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goods_id     TEXT NOT NULL,
    goods_name   TEXT NOT NULL,
    goods_icon   TEXT NOT NULL DEFAULT '🎁',
    coupon_code  TEXT UNIQUE NOT NULL,           -- 唯一兑换码
    status       TEXT NOT NULL DEFAULT 'unused', -- unused | used | transferred | discarded
    redirect_url TEXT,
    allow_instant  INTEGER NOT NULL DEFAULT 1,
    allow_transfer INTEGER NOT NULL DEFAULT 1,
    allow_discard  INTEGER NOT NULL DEFAULT 1,
    transfer_fee   INTEGER NOT NULL DEFAULT 0,
    obtained_at  TEXT NOT NULL DEFAULT (datetime('now')),
    used_at      TEXT,
    transferred_to TEXT                          -- 转送给谁的 user_id
  );

  CREATE TABLE IF NOT EXISTS shop_records (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_name   TEXT,
    uid_seq     INTEGER,
    goods_id    TEXT NOT NULL,
    goods_name  TEXT NOT NULL,
    goods_icon  TEXT NOT NULL DEFAULT '🎁',
    cost        INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 兑换码表
  CREATE TABLE IF NOT EXISTS redeem_codes (
    id          TEXT PRIMARY KEY,
    code        TEXT UNIQUE NOT NULL,
    type        TEXT NOT NULL DEFAULT 'points',  -- points | feature
    value       INTEGER NOT NULL DEFAULT 0,       -- 积分数量 or 功能次数
    feature_key TEXT,                             -- type=feature 时的功能标识
    max_uses    INTEGER NOT NULL DEFAULT 1,        -- 最大使用次数（-1=无限）
    used_count  INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'active',   -- active | disabled | expired
    expire_at   TEXT,                             -- 过期时间，null=永不过期
    note        TEXT,
    created_by  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 兑换码使用记录
  CREATE TABLE IF NOT EXISTS redeem_records (
    id          TEXT PRIMARY KEY,
    code_id     TEXT NOT NULL REFERENCES redeem_codes(id),
    code        TEXT NOT NULL,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_name   TEXT,
    uid_seq     INTEGER,
    type        TEXT NOT NULL,
    value       INTEGER NOT NULL,
    feature_key TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 功能使用次数余额（如实名认证剩余次数）
  CREATE TABLE IF NOT EXISTS feature_quota (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature_key TEXT NOT NULL,
    quota       INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, feature_key)
  );

  -- 积分与商城配置表
  CREATE TABLE IF NOT EXISTS shop_config (
    key_name  TEXT PRIMARY KEY,
    value     TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 插入默认配置（不覆盖已有值）
const defaultConfigs = {
  'checkin_points':      '10',
  'checkin_enabled':     '1',
  'checkin_period':      'day',
  'checkin_min':         '1',
  'checkin_max':         '10',
  'redeem_code_on':      '1',
  'kyc_cost_type':       'free',
  'kyc_cost_value':      '0',
  'kyc_feature_key':     'kyc',
  'transfer_enabled':    '1',
  'transfer_max_once':   '20',
  'transfer_month_limit':'3',
  'transfer_show_uid':   '1',
};
Object.entries(defaultConfigs).forEach(([k, v]) => {
  const existing = db.prepare('SELECT 1 FROM shop_config WHERE key_name=?').get(k);
  if (!existing) db.prepare("INSERT INTO shop_config (key_name,value) VALUES (?,?)").run(k, v);
});

// 获取配置辅助函数
function shopCfg(key) {
  const row = db.prepare('SELECT value FROM shop_config WHERE key_name=?').get(key);
  return row?.value ?? null;
}

// ── 用户端：获取商城配置 ──
router.get('/shop/config', requireAuth, (req, res) => {
  res.json({
    success: true,
    checkin_points:  parseInt(shopCfg('checkin_points') || '10'),
    redeem_code_on:  shopCfg('redeem_code_on') === '1',
    kyc_cost_type:   shopCfg('kyc_cost_type')  || 'free',
    kyc_cost_value:  parseInt(shopCfg('kyc_cost_value') || '0'),
  });
});

// ── 用户端：获取商品列表 ──
router.get('/shop/goods', requireAuth, (req, res) => {
  const goods = db.prepare("SELECT * FROM shop_goods WHERE status='on' ORDER BY sort_weight DESC, created_at ASC").all();
  res.json({ success: true, goods });
});

// ── 用户端：兑换商品（生成兑换券 or 盲盒）──
router.post('/shop/exchange/:id', requireAuth, async (req, res) => {
  const goods = db.prepare('SELECT * FROM shop_goods WHERE id=?').get(req.params.id);
  if (!goods || goods.status !== 'on') return res.status(404).json({ error: '商品不存在或已下架' });
  if (goods.stock === 0) return res.status(400).json({ error: '商品库存不足' });

  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.points < goods.cost) return res.status(400).json({ error: `积分不足，还需 ${goods.cost - user.points} 积分` });

  // 生成兑换券唯一码
  function genCouponCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const seg = () => Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
    return `${seg()}-${seg()}-${seg()}`;
  }

  let result = {};

  db.transaction(() => {
    // 扣积分 + 减库存
    users.addPoints.run(-goods.cost, user.id);
    points.insert.run(uuidv4(), user.id, -goods.cost, `兑换商品：${goods.name}`);
    if (goods.stock > 0) db.prepare("UPDATE shop_goods SET stock=stock-1,exchange_count=exchange_count+1,updated_at=datetime('now') WHERE id=?").run(goods.id);
    else db.prepare("UPDATE shop_goods SET exchange_count=exchange_count+1,updated_at=datetime('now') WHERE id=?").run(goods.id);

    // 记录兑换记录
    db.prepare('INSERT INTO shop_records (id,user_id,user_name,uid_seq,goods_id,goods_name,goods_icon,cost,status) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(uuidv4(), user.id, user.name, user.uid_seq, goods.id, goods.name, goods.icon, goods.cost, 'done');

    if (goods.is_blind_box) {
      // ── 盲盒逻辑 ──
      const rewards = db.prepare('SELECT * FROM blind_box_rewards WHERE goods_id=?').all(goods.id);
      if (!rewards.length) {
        result = { type: 'blind_box', opened: false, message: '盲盒暂无奖励配置，请联系管理员' };
        return;
      }
      // 加权随机选一个奖励
      const totalWeight = rewards.reduce((s, r) => s + r.weight, 0);
      let rand = Math.random() * totalWeight;
      let chosen = rewards[0];
      for (const r of rewards) { rand -= r.weight; if (rand <= 0) { chosen = r; break; } }

      result = { type: 'blind_box', reward: chosen, opened: goods.open_instantly === 1 };

      if (goods.open_instantly) {
        // 当场执行奖励
        if (chosen.type === 'points') {
          users.addPoints.run(chosen.value, user.id);
          points.insert.run(uuidv4(), user.id, chosen.value, `盲盒奖励：${chosen.label}`);
          result.executed = true;
        } else if (chosen.type === 'deduct_points') {
          const deduct = Math.min(user.points - goods.cost, chosen.value); // 不让积分为负
          if (deduct > 0) { users.addPoints.run(-deduct, user.id); points.insert.run(uuidv4(), user.id, -deduct, `盲盒扣除：${chosen.label}`); }
          result.executed = true; result.deducted = deduct;
        } else if (chosen.type === 'goods' && chosen.goods_ref) {
          // 发放另一个商品的兑换券
          const refGoods = db.prepare('SELECT * FROM shop_goods WHERE id=?').get(chosen.goods_ref);
          if (refGoods) {
            const couponCode = genCouponCode();
            db.prepare('INSERT INTO user_coupons (id,user_id,goods_id,goods_name,goods_icon,coupon_code,status,redirect_url,allow_instant,allow_transfer,allow_discard,transfer_fee) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
              .run(uuidv4(), user.id, refGoods.id, refGoods.name, refGoods.icon, couponCode, 'unused', refGoods.redirect_url, refGoods.allow_instant, refGoods.allow_transfer, refGoods.allow_discard, refGoods.transfer_fee);
            result.coupon = { code: couponCode, goods_name: refGoods.name };
          }
          result.executed = true;
        } else if (chosen.type === 'nothing') {
          result.executed = true; result.message = chosen.label;
        }
      } else {
        // 不当场打开：生成一个特殊盲盒券，稍后开启
        const couponCode = genCouponCode();
        db.prepare('INSERT INTO user_coupons (id,user_id,goods_id,goods_name,goods_icon,coupon_code,status,allow_instant,allow_transfer,allow_discard,transfer_fee) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(uuidv4(), user.id, goods.id, `【盲盒】${goods.name}`, goods.icon, couponCode, 'unused', 1, goods.allow_transfer, goods.allow_discard, goods.transfer_fee);
        // 把奖励信息存到 coupon 的 note 字段
        db.prepare("UPDATE user_coupons SET redirect_url=? WHERE coupon_code=?").run(JSON.stringify(chosen), couponCode);
        result.coupon = { code: couponCode, is_blind: true };
      }

    } else {
      // ── 普通商品：生成兑换券 ──
      const couponCode = genCouponCode();
      db.prepare('INSERT INTO user_coupons (id,user_id,goods_id,goods_name,goods_icon,coupon_code,status,redirect_url,allow_instant,allow_transfer,allow_discard,transfer_fee) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(uuidv4(), user.id, goods.id, goods.name, goods.icon, couponCode, 'unused',
          goods.redirect_url, goods.allow_instant, goods.allow_transfer, goods.allow_discard, goods.transfer_fee);
      result = { type: 'coupon', coupon: { code: couponCode, goods_name: goods.name, allow_instant: goods.allow_instant, redirect_url: goods.redirect_url } };
    }
  })();

  const updated = users.findById.get(user.id);
  res.json({ success: true, remain: updated.points, ...result });
});

// ── 用户端：我的兑换券 ──
router.get('/user/coupons', requireAuth, (req, res) => {
  const coupons = db.prepare("SELECT * FROM user_coupons WHERE user_id=? ORDER BY obtained_at DESC").all(req.user.uid);
  res.json({ success: true, coupons });
});

// ── 用户端：使用兑换券（当场兑换）──
router.post('/user/coupons/:code/use', requireAuth, (req, res) => {
  const c = db.prepare("SELECT * FROM user_coupons WHERE coupon_code=? AND user_id=?").get(req.params.code, req.user.uid);
  if (!c) return res.status(404).json({ error: '兑换券不存在' });
  if (c.status !== 'unused') return res.status(400).json({ error: `兑换券已${c.status==='used'?'使用':c.status==='transferred'?'转送':c.status==='discarded'?'丢弃':'失效'}` });
  if (!c.allow_instant) return res.status(403).json({ error: '该兑换券不允许当场兑换' });

  db.prepare("UPDATE user_coupons SET status='used',used_at=datetime('now') WHERE coupon_code=?").run(c.coupon_code);
  const redirect = c.redirect_url && !c.redirect_url.startsWith('{') ? c.redirect_url : null;
  res.json({ success: true, redirect_url: redirect, message: redirect ? '即将跳转使用' : '兑换券已核销' });
});

// ── 用户端：丢弃兑换券 ──
router.post('/user/coupons/:code/discard', requireAuth, (req, res) => {
  const c = db.prepare("SELECT * FROM user_coupons WHERE coupon_code=? AND user_id=?").get(req.params.code, req.user.uid);
  if (!c) return res.status(404).json({ error: '兑换券不存在' });
  if (c.status !== 'unused') return res.status(400).json({ error: '兑换券已不可操作' });
  if (!c.allow_discard) return res.status(403).json({ error: '该兑换券不允许丢弃' });
  db.prepare("UPDATE user_coupons SET status='discarded' WHERE coupon_code=?").run(c.coupon_code);
  res.json({ success: true });
});

// ── 用户端：转送兑换券给他人 ──
router.post('/user/coupons/:code/transfer', requireAuth, async (req, res) => {
  const { to_uid, to_name, password } = req.body;
  const c = db.prepare("SELECT * FROM user_coupons WHERE coupon_code=? AND user_id=?").get(req.params.code, req.user.uid);
  if (!c) return res.status(404).json({ error: '兑换券不存在' });
  if (c.status !== 'unused') return res.status(400).json({ error: '兑换券已不可操作' });
  if (!c.allow_transfer) return res.status(403).json({ error: '该兑换券不允许转送' });
  if (!to_uid || !to_name) return res.status(400).json({ error: '请提供收件人 UID 和用户名' });
  if (!password) return res.status(400).json({ error: '请输入登录密码确认转送' });

  // 验密
  const fromUser = users.findById.get(req.user.uid);
  const pwOk = await bcrypt.compare(password, fromUser.password_hash || '');
  if (!pwOk) return res.status(401).json({ error: '密码错误' });

  // 查找收件人
  const toUser = db.prepare('SELECT * FROM users WHERE (uid_seq=? OR id=?) AND name=?').get(to_uid, to_uid, to_name.trim());
  if (!toUser) return res.status(404).json({ error: 'UID 与用户名不匹配' });
  if (toUser.id === req.user.uid) return res.status(400).json({ error: '不能转送给自己' });

  // 扣除转送手续费
  if (c.transfer_fee > 0) {
    if (fromUser.points < c.transfer_fee) return res.status(400).json({ error: `积分不足，转送需手续费 ${c.transfer_fee} 分` });
    users.addPoints.run(-c.transfer_fee, fromUser.id);
    points.insert.run(uuidv4(), fromUser.id, -c.transfer_fee, `转送兑换券手续费（${c.goods_name}）`);
  }

  db.prepare("UPDATE user_coupons SET user_id=?,status='unused',transferred_to=? WHERE coupon_code=?")
    .run(toUser.id, req.user.uid, c.coupon_code);

  res.json({ success: true, to_name: toUser.name, fee: c.transfer_fee });
});

// ── 开放 API：核验用户兑换券 ──
router.get('/v1/coupon/verify', requireApiKey('redeem:verify'), (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: '请提供兑换券码' });
  const c = db.prepare('SELECT * FROM user_coupons WHERE coupon_code=?').get(code.trim().toUpperCase());
  if (!c) return res.json({ valid: false, reason: '兑换券不存在' });
  if (c.status !== 'unused') return res.json({ valid: false, reason: `状态：${c.status}` });
  res.json({ valid: true, goods_name: c.goods_name, user_id: c.user_id });
});

// ── 开放 API：核销用户兑换券（第三方系统调用）──
router.post('/v1/coupon/use', requireApiKey('redeem:verify'), (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: '请提供兑换券码' });
  const c = db.prepare('SELECT * FROM user_coupons WHERE coupon_code=?').get(code.trim().toUpperCase());
  if (!c) return res.status(404).json({ error: '兑换券不存在' });
  if (c.status !== 'unused') return res.status(400).json({ error: `兑换券已${c.status}` });
  db.prepare("UPDATE user_coupons SET status='used',used_at=datetime('now') WHERE coupon_code=?").run(c.coupon_code);
  res.json({ success: true, goods_name: c.goods_name, user_id: c.user_id });
});

// ── 管理端：盲盒奖励配置 ──
router.get('/admin/shop/goods/:id/rewards', requireAdmin(2), (req, res) => {
  const rewards = db.prepare('SELECT * FROM blind_box_rewards WHERE goods_id=? ORDER BY weight DESC').all(req.params.id);
  res.json({ success: true, rewards });
});

router.post('/admin/shop/goods/:id/rewards', requireAdmin(2), (req, res) => {
  const { type, value, goods_ref, label, weight } = req.body;
  if (!type || !label) return res.status(400).json({ error: '类型和显示名称为必填' });
  const id = uuidv4();
  db.prepare('INSERT INTO blind_box_rewards (id,goods_id,type,value,goods_ref,label,weight) VALUES (?,?,?,?,?,?,?)')
    .run(id, req.params.id, type, parseInt(value)||0, goods_ref||null, label, parseInt(weight)||10);
  res.json({ success: true, id });
});

router.delete('/admin/shop/goods/:id/rewards/:rid', requireAdmin(2), (req, res) => {
  db.prepare('DELETE FROM blind_box_rewards WHERE id=? AND goods_id=?').run(req.params.rid, req.params.id);
  res.json({ success: true });
});

// ── 管理端：查看用户兑换券 ──
router.get('/admin/shop/coupons', requireAdmin(3), (req, res) => {
  const { user_id } = req.query;
  const coupons = user_id
    ? db.prepare('SELECT * FROM user_coupons WHERE user_id=? ORDER BY obtained_at DESC').all(user_id)
    : db.prepare('SELECT * FROM user_coupons ORDER BY obtained_at DESC LIMIT 200').all();
  res.json({ success: true, coupons });
});

// ── 管理端：手动作废用户兑换券 ──
router.patch('/admin/shop/coupons/:code', requireAdmin(2), (req, res) => {
  const { status } = req.body;
  db.prepare("UPDATE user_coupons SET status=? WHERE coupon_code=?").run(status, req.params.code);
  res.json({ success: true });
});

// ── 用户端：兑换记录 ──
router.get('/shop/records', requireAuth, (req, res) => {
  const records = db.prepare('SELECT * FROM shop_records WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.uid);
  res.json({ success: true, records });
});

// ── 用户端：使用兑换码 ──
router.post('/shop/redeem', requireAuth, (req, res) => {
  // 检查兑换码功能是否开启
  if (shopCfg('redeem_code_on') !== '1') {
    return res.status(403).json({ error: '兑换码功能暂未开放' });
  }

  const { code } = req.body;
  if (!code?.trim()) return res.status(400).json({ error: '请输入兑换码' });

  const codeRow = db.prepare("SELECT * FROM redeem_codes WHERE code=? AND status='active'").get(code.trim().toUpperCase());
  if (!codeRow) return res.status(404).json({ error: '兑换码不存在或已失效' });

  // 检查过期
  if (codeRow.expire_at && new Date(codeRow.expire_at) < new Date()) {
    db.prepare("UPDATE redeem_codes SET status='expired' WHERE id=?").run(codeRow.id);
    return res.status(400).json({ error: '兑换码已过期' });
  }
  // 检查使用次数
  if (codeRow.max_uses !== -1 && codeRow.used_count >= codeRow.max_uses) {
    return res.status(400).json({ error: '该兑换码已达使用上限' });
  }
  // 检查是否已使用过（同一用户）
  const usedBefore = db.prepare('SELECT 1 FROM redeem_records WHERE code_id=? AND user_id=?').get(codeRow.id, req.user.uid);
  if (usedBefore) return res.status(400).json({ error: '你已使用过该兑换码' });

  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 执行兑换（事务）
  db.transaction(() => {
    if (codeRow.type === 'points') {
      users.addPoints.run(codeRow.value, user.id);
      points.insert.run(uuidv4(), user.id, codeRow.value, `兑换码奖励：${code}`);
    } else if (codeRow.type === 'feature') {
      db.prepare(`INSERT INTO feature_quota (user_id,feature_key,quota,updated_at)
        VALUES (?,?,?,datetime('now'))
        ON CONFLICT(user_id,feature_key) DO UPDATE SET quota=quota+?,updated_at=datetime('now')`)
        .run(user.id, codeRow.feature_key, codeRow.value, codeRow.value);
    }
    db.prepare('UPDATE redeem_codes SET used_count=used_count+1 WHERE id=?').run(codeRow.id);
    if (codeRow.max_uses !== -1 && codeRow.used_count + 1 >= codeRow.max_uses) {
      db.prepare("UPDATE redeem_codes SET status='disabled' WHERE id=?").run(codeRow.id);
    }
    db.prepare('INSERT INTO redeem_records (id,code_id,code,user_id,user_name,uid_seq,type,value,feature_key) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(uuidv4(), codeRow.id, code.trim().toUpperCase(), user.id, user.name, user.uid_seq,
        codeRow.type, codeRow.value, codeRow.feature_key || null);
  })();

  const updated = users.findById.get(user.id);
  const result = {
    success: true,
    type: codeRow.type,
    value: codeRow.value,
    feature_key: codeRow.feature_key,
    points_now: updated.points,
  };
  if (codeRow.type === 'points') {
    result.message = `🎉 成功兑换 +${codeRow.value} 积分！当前积分：${updated.points}`;
  } else {
    result.message = `🎉 成功兑换「${codeRow.feature_key}」使用次数 +${codeRow.value} 次！`;
  }
  res.json(result);
});

// ── 用户端：查询功能次数余额 ──
router.get('/shop/quota/:feature_key', requireAuth, (req, res) => {
  const row = db.prepare('SELECT quota FROM feature_quota WHERE user_id=? AND feature_key=?').get(req.user.uid, req.params.feature_key);
  res.json({ success: true, quota: row?.quota || 0 });
});

// ── 用户端：兑换码使用记录 ──
router.get('/shop/redeem-records', requireAuth, (req, res) => {
  const records = db.prepare('SELECT * FROM redeem_records WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.uid);
  res.json({ success: true, records });
});

// ── 修改签到接口：读取配置积分、周期、随机区间 ──
router.post('/user/checkin/v2', requireAuth, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 签到是否开放
  if (shopCfg('checkin_enabled') === '0') {
    return res.status(403).json({ error: '签到功能暂未开放' });
  }

  // 签到周期判断
  const period = shopCfg('checkin_period') || 'day'; // day|week|month|quarter|year|hour
  const now = new Date();
  const lastCheckin = user.last_checkin ? new Date(user.last_checkin) : null;

  function isSamePeriod(a, b, p) {
    if (!a) return false;
    if (p === 'hour')    return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate() && a.getHours()===b.getHours();
    if (p === 'day')     return a.toISOString().slice(0,10) === b.toISOString().slice(0,10);
    if (p === 'week')    return a.getFullYear()===b.getFullYear() && getWeek(a)===getWeek(b);
    if (p === 'month')   return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth();
    if (p === 'quarter') return a.getFullYear()===b.getFullYear() && Math.floor(a.getMonth()/3)===Math.floor(b.getMonth()/3);
    if (p === 'year')    return a.getFullYear()===b.getFullYear();
    return false;
  }
  function getWeek(d) {
    const s = new Date(d.getFullYear(), 0, 1);
    return Math.ceil(((d - s) / 86400000 + s.getDay() + 1) / 7);
  }

  if (lastCheckin && isSamePeriod(lastCheckin, now, period)) {
    const periodLabel = {hour:'小时',day:'天',week:'周',month:'月',quarter:'季度',year:'年'}[period]||'天';
    return res.status(400).json({ error: `本${periodLabel}已签到` });
  }

  // 计算签到积分（随机区间）
  const minPts = Math.max(1, parseInt(shopCfg('checkin_min') || '1'));
  const maxPts = Math.max(minPts, parseInt(shopCfg('checkin_max') || shopCfg('checkin_points') || '10'));
  const pts = minPts === maxPts ? minPts : Math.floor(Math.random() * (maxPts - minPts + 1)) + minPts;

  // 连续签到
  const yesterday = new Date(now - 86400000).toISOString().slice(0,10);
  const todayStr  = now.toISOString().slice(0,10);
  if (user.last_checkin === yesterday) users.checkin.run(user.id);
  else users.resetStreak.run(user.id);

  users.addPoints.run(pts, user.id);
  points.insert.run(uuidv4(), user.id, pts, '每日签到');
  db.prepare("UPDATE users SET last_checkin=? WHERE id=?").run(now.toISOString(), user.id);

  const updated = users.findById.get(user.id);
  res.json({ success: true, points: pts, min: minPts, max: maxPts, streak: updated.checkin_streak, total: updated.points });
});

// ── 管理端：商品管理 ──
router.get('/admin/shop/goods', requireAdmin(3), (req, res) => {
  const goods = db.prepare('SELECT * FROM shop_goods ORDER BY sort_weight DESC, created_at ASC').all();
  res.json({ success: true, goods });
});

router.get('/admin/shop/goods/:id', requireAdmin(3), (req, res) => {
  const goods = db.prepare('SELECT * FROM shop_goods WHERE id=?').get(req.params.id);
  if (!goods) return res.status(404).json({ error: '商品不存在' });
  res.json({ success: true, goods });
});

router.post('/admin/shop/goods', requireAdmin(2), (req, res) => {
  const { name, icon = '🎁', description = '', note = '', cost, stock = -1, status = 'on', sort_weight = 0 } = req.body;
  if (!name || !cost) return res.status(400).json({ error: '商品名称和积分为必填' });
  const id = uuidv4();
  db.prepare('INSERT INTO shop_goods (id,name,icon,description,note,cost,stock,status,sort_weight) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, name, icon, description, note, cost, stock, status, sort_weight);
  res.json({ success: true, goods: db.prepare('SELECT * FROM shop_goods WHERE id=?').get(id) });
});

router.patch('/admin/shop/goods/:id', requireAdmin(2), (req, res) => {
  const goods = db.prepare('SELECT * FROM shop_goods WHERE id=?').get(req.params.id);
  if (!goods) return res.status(404).json({ error: '商品不存在' });
  const { name, icon, description, note, cost, stock, status, sort_weight } = req.body;
  db.prepare(`UPDATE shop_goods SET
    name=COALESCE(?,name), icon=COALESCE(?,icon), description=COALESCE(?,description),
    note=COALESCE(?,note), cost=COALESCE(?,cost), stock=COALESCE(?,stock),
    status=COALESCE(?,status), sort_weight=COALESCE(?,sort_weight),
    updated_at=datetime('now') WHERE id=?`)
    .run(name??null, icon??null, description??null, note??null, cost??null, stock??null, status??null, sort_weight??null, goods.id);
  res.json({ success: true });
});

// ── 管理端：兑换记录 ──
router.get('/admin/shop/records', requireAdmin(3), (req, res) => {
  const records = db.prepare('SELECT * FROM shop_records ORDER BY created_at DESC LIMIT 200').all();
  res.json({ success: true, records });
});

router.patch('/admin/shop/records/:id', requireAdmin(2), (req, res) => {
  const { status, note } = req.body;
  db.prepare("UPDATE shop_records SET status=COALESCE(?,status),note=COALESCE(?,note),updated_at=datetime('now') WHERE id=?")
    .run(status ?? null, note ?? null, req.params.id);
  res.json({ success: true });
});

// ── 管理端：兑换码管理 ──
router.get('/admin/shop/codes', requireAdmin(2), (req, res) => {
  const codes = db.prepare('SELECT * FROM redeem_codes ORDER BY created_at DESC').all();
  res.json({ success: true, codes });
});

router.post('/admin/shop/codes', requireAdmin(2), (req, res) => {
  const { type = 'points', value, feature_key, max_uses = 1, expire_at, note, count = 1 } = req.body;
  if (!value || value <= 0) return res.status(400).json({ error: '兑换价值必须大于 0' });
  if (type === 'feature' && !feature_key) return res.status(400).json({ error: 'feature 类型需指定 feature_key' });

  const generated = [];
  const num = Math.min(parseInt(count) || 1, 500); // 单次最多批量生成 500 个
  for (let i = 0; i < num; i++) {
    const code = generateCode();
    const id = uuidv4();
    db.prepare(`INSERT INTO redeem_codes (id,code,type,value,feature_key,max_uses,status,expire_at,note,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, code, type, parseInt(value), feature_key || null, parseInt(max_uses) || 1, 'active', expire_at || null, note || null, req.user.uid);
    generated.push(code);
  }
  res.json({ success: true, codes: generated, count: generated.length });
});

router.patch('/admin/shop/codes/:id', requireAdmin(2), (req, res) => {
  const { status, expire_at, note, max_uses } = req.body;
  db.prepare(`UPDATE redeem_codes SET
    status=COALESCE(?,status), expire_at=COALESCE(?,expire_at),
    note=COALESCE(?,note), max_uses=COALESCE(?,max_uses)
    WHERE id=?`)
    .run(status ?? null, expire_at ?? null, note ?? null, max_uses ?? null, req.params.id);
  res.json({ success: true });
});

router.get('/admin/shop/redeem-records', requireAdmin(3), (req, res) => {
  const records = db.prepare('SELECT * FROM redeem_records ORDER BY created_at DESC LIMIT 300').all();
  res.json({ success: true, records });
});

// ── 管理端：商城/积分配置 ──
router.get('/admin/shop/config', requireAdmin(2), (req, res) => {
  const rows = db.prepare('SELECT * FROM shop_config').all();
  const cfg = {};
  rows.forEach(r => { cfg[r.key_name] = r.value; });
  res.json({ success: true, config: cfg });
});

router.post('/admin/shop/config', requireAdmin(2), (req, res) => {
  const { checkin_enabled, checkin_period, checkin_min, checkin_max,
          redeem_code_on, kyc_cost_type, kyc_cost_value, kyc_feature_key,
          sms_poll_strategy, email_poll_strategy, kyc_poll_strategy } = req.body;
  const updates = {};
  if (checkin_enabled !== undefined) updates['checkin_enabled']  = checkin_enabled ? '1' : '0';
  if (checkin_period  !== undefined) updates['checkin_period']   = ['hour','day','week','month','quarter','year'].includes(checkin_period) ? checkin_period : 'day';
  if (checkin_min     !== undefined) updates['checkin_min']      = String(Math.max(1, parseInt(checkin_min)||1));
  if (checkin_max     !== undefined) updates['checkin_max']      = String(Math.max(parseInt(updates['checkin_min']||'1'), parseInt(checkin_max)||10));
  if (redeem_code_on  !== undefined) updates['redeem_code_on']   = redeem_code_on ? '1' : '0';
  if (kyc_cost_type   !== undefined) updates['kyc_cost_type']    = ['free','points','redeem_code'].includes(kyc_cost_type) ? kyc_cost_type : 'free';
  if (kyc_cost_value  !== undefined) updates['kyc_cost_value']   = String(Math.max(0, parseInt(kyc_cost_value)||0));
  if (kyc_feature_key !== undefined) updates['kyc_feature_key']  = kyc_feature_key;
  if (sms_poll_strategy   !== undefined) updates['sms_poll_strategy']   = ['least','sequential','single','user_choice'].includes(sms_poll_strategy)   ? sms_poll_strategy   : 'least';
  if (email_poll_strategy !== undefined) updates['email_poll_strategy'] = ['least','sequential','single','user_choice'].includes(email_poll_strategy) ? email_poll_strategy : 'least';
  if (kyc_poll_strategy   !== undefined) updates['kyc_poll_strategy']   = ['least','sequential','single','user_choice'].includes(kyc_poll_strategy)   ? kyc_poll_strategy   : 'least';
  // single 模式下的指定服务商
  if (req.body.sms_single_provider)   updates['sms_single_provider']   = req.body.sms_single_provider;
  if (req.body.email_single_provider) updates['email_single_provider'] = req.body.email_single_provider;
  if (req.body.kyc_single_provider)   updates['kyc_single_provider']   = req.body.kyc_single_provider;
  Object.entries(updates).forEach(([k, v]) =>
    db.prepare("INSERT OR REPLACE INTO shop_config (key_name,value,updated_at) VALUES (?,?,datetime('now'))").run(k, v)
  );
  res.json({ success: true });
});

// 生成随机兑换码（格式：XXXX-XXXX-XXXX）
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
  const seg = () => Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${seg()}-${seg()}-${seg()}`;
}

// ──────────────────────────────────────────
// 开发模拟登录（仅 setup 未完成时可用）
// ──────────────────────────────────────────
router.post('/dev/login', async (req, res) => {
  const { isSetupDone } = require('./db');

  // setup 完成后直接拒绝，不论任何情况
  if (isSetupDone()) {
    return res.status(403).json({ error: '系统已完成配置，模拟登录已关闭' });
  }

  const { role = 'user' } = req.body;

  // 模拟账号配置
  const DEV_ACCOUNTS = {
    admin: { email: 'admin@dev.local',  name: '开发管理员', role: 'admin', admin_level: 1, user_level: 1 },
    ops:   { email: 'ops@dev.local',    name: '运营管理员', role: 'admin', admin_level: 2, user_level: 1 },
    user:  { email: 'user@dev.local',   name: '测试用户',   role: 'user',  admin_level: null, user_level: 4 },
    vip:   { email: 'vip@dev.local',    name: 'VIP用户',    role: 'user',  admin_level: null, user_level: 1 },
  };

  const acc = DEV_ACCOUNTS[role];
  if (!acc) return res.status(400).json({ error: '无效的角色参数' });

  // 查找或自动创建模拟账号
  let user = users.findByEmail.get(acc.email);
  if (!user) {
    const bcrypt = require('bcryptjs');
    const { v4: uuid } = require('uuid');
    const hash = await bcrypt.hash('dev-password-' + role, 6); // 轮次低，仅开发用
    const seq  = nextUidSeq();
    users.insert.run({
      id: uuid(), uid_seq: seq,
      name: acc.name, email: acc.email,
      phone: null, password_hash: hash,
      role: acc.role, admin_level: acc.admin_level,
      user_level: acc.user_level, status: 'active',
    });
    // 给 VIP/admin 预置一些积分，方便测试商城
    user = users.findByEmail.get(acc.email);
    if (user && ['admin','vip'].includes(role)) {
      users.addPoints.run(500, user.id);
    }
  }

  // 记录模拟登录日志
  try {
    logs.insert.run({
      id: uuidv4(), user_id: user.id, user_name: user.name,
      uid_seq: String(user.uid_seq), method: `开发模拟登录（${role}）`,
      app_name: '本系统', ip: req.ip, user_agent: req.headers['user-agent'],
      status: 'success', fail_reason: null,
    });
  } catch(_) {}
  const token = signToken({
    uid: user.id, name: user.name,
    role: user.role, adminLevel: user.admin_level,
    _dev: true, // 携带标记，方便识别
  });

  // 不含密码的用户数据
  const { password_hash, ...safeUser } = user;
  res.json({ success: true, token, user: safeUser, _dev: true });
});

// ── 退出登录（客户端清除 token，服务端记录日志）──
router.post('/user/logout', requireAuth, (req, res) => {
  try {
    logs.insert.run({
      id: uuidv4(), user_id: req.user.uid, user_name: null,
      uid_seq: null, method: '退出登录', app_name: '本系统',
      ip: req.ip, user_agent: req.headers['user-agent'],
      status: 'success', fail_reason: null,
    });
  } catch(_) {}
  res.json({ success: true });
});

// ── 检查用户名是否唯一 ──
router.get('/user/check-name', requireAuth, (req, res) => {
  const { name } = req.query;
  if (!name?.trim()) return res.status(400).json({ error: '用户名不能为空' });
  const existing = db.prepare('SELECT id FROM users WHERE name=? AND id!=?').get(name.trim(), req.user.uid);
  res.json({ available: !existing });
});

// ── 积分转账 ──
router.post('/shop/transfer', requireAuth, async (req, res) => {
  const { to_uid, to_name, amount, password } = req.body;
  const pts = parseInt(amount);
  if (!to_uid || !to_name) return res.status(400).json({ error: '请输入收款用户 UID 和用户名' });
  if (!pts || pts < 1)    return res.status(400).json({ error: '转账积分至少 1 分' });
  if (!password)          return res.status(400).json({ error: '请输入登录密码以确认转账' });

  // 读取转账配置
  const maxOnce    = parseInt(shopCfg('transfer_max_once')    || '20');
  const monthLimit = parseInt(shopCfg('transfer_month_limit') || '3');
  const enabled    = shopCfg('transfer_enabled') !== '0';
  if (!enabled) return res.status(403).json({ error: '积分转账功能已关闭' });
  if (pts > maxOnce) return res.status(400).json({ error: `单次最多转账 ${maxOnce} 积分` });

  // 验证发起人密码
  const fromUser = users.findById.get(req.user.uid);
  if (!fromUser) return res.status(404).json({ error: '用户不存在' });
  if (!fromUser.password_hash) return res.status(400).json({ error: '账号未设置密码，无法发起转账' });
  const pwOk = await bcrypt.compare(password, fromUser.password_hash);
  if (!pwOk) return res.status(401).json({ error: '密码错误，转账已取消' });

  // 检查本月发起次数
  const monthCount = db.prepare(`
    SELECT COUNT(*) as n FROM points_log
    WHERE user_id=? AND reason LIKE '转账给%'
    AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `).get(fromUser.id).n;
  if (monthCount >= monthLimit) return res.status(400).json({ error: `本月转账次数已达上限（${monthLimit} 次）` });

  // 查找收款用户：UID 和昵称必须同时匹配
  const toUser = db.prepare(
    'SELECT * FROM users WHERE (uid_seq=? OR id=?) AND name=?'
  ).get(to_uid, to_uid, to_name.trim());
  if (!toUser) return res.status(404).json({ error: 'UID 与用户名不匹配，请确认后重试' });
  if (toUser.id === fromUser.id) return res.status(400).json({ error: '不能给自己转账' });
  if (toUser.status === 'disabled') return res.status(400).json({ error: '收款用户已停用' });
  if (fromUser.points < pts) return res.status(400).json({ error: `积分不足，当前 ${fromUser.points} 分` });

  // 执行转账（事务）
  db.transaction(() => {
    users.addPoints.run(-pts, fromUser.id);
    users.addPoints.run(pts, toUser.id);
    points.insert.run(uuidv4(), fromUser.id, -pts, `转账给 ${toUser.name}（UID#${String(toUser.uid_seq).padStart(5,'0')}）`);
    points.insert.run(uuidv4(), toUser.id,   pts, `收到来自 ${fromUser.name} 的转账`);
  })();

  const updated = users.findById.get(fromUser.id);
  res.json({ success: true, remain: updated.points, to_name: toUser.name });
});

// ── 查找用户（转账用，始终要求 UID+昵称匹配）──
router.get('/shop/find-user', requireAuth, (req, res) => {
  const { uid, name } = req.query;
  if (!uid || !name) return res.status(400).json({ error: '请同时输入 UID 和用户名' });
  const u = db.prepare(
    'SELECT id,uid_seq,name,status FROM users WHERE (uid_seq=? OR id=?) AND name=?'
  ).get(uid, uid, name.trim());
  if (!u) return res.status(404).json({ error: 'UID 与用户名不匹配' });
  res.json({ success: true, user: { uid_seq: u.uid_seq, name: u.name, status: u.status } });
});

// ── 管理端：积分转账配置 ──
router.post('/admin/shop/transfer-config', requireAdmin(2), (req, res) => {
  const { enabled, max_once, month_limit, show_uid } = req.body;
  if (enabled   !== undefined) db.prepare("INSERT OR REPLACE INTO shop_config(key_name,value) VALUES('transfer_enabled',?)").run(enabled ? '1' : '0');
  if (max_once  !== undefined) db.prepare("INSERT OR REPLACE INTO shop_config(key_name,value) VALUES('transfer_max_once',?)").run(String(parseInt(max_once)||20));
  if (month_limit!==undefined) db.prepare("INSERT OR REPLACE INTO shop_config(key_name,value) VALUES('transfer_month_limit',?)").run(String(parseInt(month_limit)||3));
  if (show_uid  !== undefined) db.prepare("INSERT OR REPLACE INTO shop_config(key_name,value) VALUES('transfer_show_uid',?)").run(show_uid ? '1' : '0');
  res.json({ success: true });
});

// ── 管理端：设置用户能否改用户名 / 邮箱 / 手机 ──
router.patch('/admin/users/:id/permissions', requireAdmin(2), (req, res) => {
  const { can_rename, can_change_email, can_change_phone } = req.body;
  const user = users.findById.get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (can_rename      !== undefined) db.prepare("UPDATE users SET can_rename=? WHERE id=?").run(can_rename      ? 1 : 0, user.id);
  if (can_change_email!== undefined) db.prepare("UPDATE users SET can_change_email=? WHERE id=?").run(can_change_email ? 1 : 0, user.id);
  if (can_change_phone!== undefined) db.prepare("UPDATE users SET can_change_phone=? WHERE id=?").run(can_change_phone ? 1 : 0, user.id);
  res.json({ success: true });
});

// ── 管理端：积分划转（增减任意用户积分）──
router.post('/admin/users/:id/points', requireAdmin(2), (req, res) => {
  const { delta, reason } = req.body;
  const pts = parseInt(delta);
  if (!pts || pts === 0) return res.status(400).json({ error: '积分变动量不能为 0' });
  const user = users.findById.get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.points + pts < 0) return res.status(400).json({ error: `扣除后积分将为负数（当前 ${user.points}）` });
  users.addPoints.run(pts, user.id);
  points.insert.run(uuidv4(), user.id, pts, reason || (pts > 0 ? '管理员增加积分' : '管理员扣减积分'));
  const updated = users.findById.get(user.id);
  res.json({ success: true, points: updated.points });
});

// ── 管理端：作废兑换码 + 可选撤销已兑换积分 ──
router.post('/admin/shop/codes/:id/revoke', requireAdmin(2), (req, res) => {
  const { recall_points = false } = req.body; // 是否撤销已兑换积分
  const code = db.prepare('SELECT * FROM redeem_codes WHERE id=?').get(req.params.id);
  if (!code) return res.status(404).json({ error: '兑换码不存在' });

  db.transaction(() => {
    // 将兑换码标记为已作废
    db.prepare("UPDATE redeem_codes SET status='revoked' WHERE id=?").run(code.id);

    if (recall_points && code.type === 'points') {
      // 撤销所有使用该码的积分
      const records = db.prepare('SELECT * FROM redeem_records WHERE code_id=?').all(code.id);
      records.forEach(r => {
        const u = users.findById.get(r.user_id);
        if (!u) return;
        const deduct = Math.min(u.points, code.value); // 最多扣到 0
        if (deduct > 0) {
          users.addPoints.run(-deduct, u.id);
          points.insert.run(uuidv4(), u.id, -deduct, `兑换码积分撤销（${code.code}）`);
        }
      });
    }
  })();

  res.json({ success: true, recall_points });
});

// ── 解绑保护：检查是否为最后一个登录方式 ──
router.delete('/user/oauth/:provider', requireAuth, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 统计当前登录方式数量
  const oauthCount = db.prepare('SELECT COUNT(*) as n FROM user_oauth WHERE user_id=?').get(user.id).n;
  const hasEmail   = !!user.email && !!user.password_hash;
  const hasPhone   = !!user.phone;
  const totalMethods = oauthCount + (hasEmail ? 1 : 0) + (hasPhone ? 1 : 0);

  if (totalMethods <= 1) {
    return res.status(400).json({ error: '至少保留一种登录方式，无法解绑' });
  }

  db.prepare('DELETE FROM user_oauth WHERE user_id=? AND provider=?').run(user.id, req.params.provider);
  res.json({ success: true });
});

// ── 系统时区配置 ──
router.get('/admin/config/timezone', requireAdmin(2), (req, res) => {
  const tz = db.prepare("SELECT value FROM shop_config WHERE key_name='system_timezone'").get();
  res.json({ success: true, timezone: tz?.value || 'auto' });
});
router.post('/admin/config/timezone', requireAdmin(2), (req, res) => {
  const { timezone } = req.body;
  if (!timezone) return res.status(400).json({ error: '时区不能为空' });
  db.prepare("INSERT OR REPLACE INTO shop_config(key_name,value) VALUES('system_timezone',?)").run(timezone);
  res.json({ success: true });
});

// ── 开放 API：核验兑换码有效性 ──
router.get('/v1/redeem/verify', requireApiKey('redeem:verify'), (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: '请提供兑换码' });
  const c = db.prepare("SELECT * FROM redeem_codes WHERE code=?").get(code.trim().toUpperCase());
  if (!c) return res.json({ valid: false, reason: '兑换码不存在' });
  if (c.status !== 'active') return res.json({ valid: false, reason: `兑换码状态：${c.status}` });
  if (c.expire_at && new Date(c.expire_at) < new Date()) return res.json({ valid: false, reason: '已过期' });
  if (c.max_uses !== -1 && c.used_count >= c.max_uses) return res.json({ valid: false, reason: '已达使用上限' });
  res.json({ valid: true, type: c.type, value: c.value, feature_key: c.feature_key, remaining: c.max_uses === -1 ? -1 : c.max_uses - c.used_count });
});

module.exports = router;
