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
router.get('/user/me', requireAuth, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const oauthBinds = oauth.findByUser.all(user.id);
  res.json({ success: true, user: { ...safeUser(user), oauthBinds } });
});

router.post('/user/profile', requireAuth, (req, res) => {
  const { name, phone } = req.body;
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (phone && phone !== user.phone && users.findByPhone.get(phone)) return res.status(400).json({ error: '该手机号已被占用' });
  db.prepare("UPDATE users SET name=COALESCE(?,name),phone=COALESCE(?,phone),updated_at=datetime('now') WHERE id=?").run(name||null, phone||null, user.id);
  res.json({ success: true });
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
  if (q) rows = db.prepare("SELECT * FROM users WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? ORDER BY uid_seq").all(`%${q}%`,`%${q}%`,`%${q}%`);
  else if (status) rows = users.findByStatus.all(status);
  else rows = users.findAll.all();
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

router.post('/admin/users/:id/disable', requireAdmin(2), (req, res) => {
  db.prepare("UPDATE users SET status='disabled',updated_at=datetime('now') WHERE id=?").run(req.params.id);
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

module.exports = router;
