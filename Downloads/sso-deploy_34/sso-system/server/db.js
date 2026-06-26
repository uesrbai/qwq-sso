/**
 * 数据库层 - better-sqlite3
 * 所有数据持久化到 data/sso.db
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'sso.db'));

// WAL 模式提升并发性能
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 迁移：补充用户权限字段（已存在则跳过）
try { db.exec('ALTER TABLE users ADD COLUMN can_rename INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec('ALTER TABLE users ADD COLUMN can_change_email INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec('ALTER TABLE users ADD COLUMN can_change_phone INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec("ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'auto'"); } catch(_) {}
try { db.exec("ALTER TABLE shop_goods ADD COLUMN redeem_mode TEXT NOT NULL DEFAULT 'code'"); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN allow_instant INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN redirect_url TEXT'); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN allow_transfer INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN transfer_fee INTEGER NOT NULL DEFAULT 0'); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN allow_discard INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN is_blind_box INTEGER NOT NULL DEFAULT 0'); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN open_instantly INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec("ALTER TABLE apps ADD COLUMN status TEXT NOT NULL DEFAULT 'enabled'"); } catch(_) {}

// 服务商调用计数表（用于轮询）
try {
  db.exec(`CREATE TABLE IF NOT EXISTS provider_stats (
    provider  TEXT PRIMARY KEY,
    call_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    last_used  TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
} catch(_) {}

// 轮询策略配置
try {
  db.exec(`INSERT OR IGNORE INTO shop_config(key_name,value) VALUES
    ('sms_poll_strategy','least'),
    ('email_poll_strategy','least'),
    ('kyc_poll_strategy','least')`
  );
} catch(_) {}

// ──────────────────────────────────────────
// 建表
// ──────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    uid_seq     INTEGER UNIQUE,          -- 自增友好编号 00001
    name        TEXT NOT NULL DEFAULT '',
    email       TEXT UNIQUE,
    phone       TEXT UNIQUE,
    avatar      TEXT,
    password_hash TEXT,
    role        TEXT NOT NULL DEFAULT 'user',   -- user | admin
    admin_level INTEGER,                         -- 管理员: 1/2/3
    user_level  INTEGER NOT NULL DEFAULT 4,      -- 普通用户: 1~5
    status      TEXT NOT NULL DEFAULT 'active',  -- active | disabled
    kyc_verified INTEGER NOT NULL DEFAULT 0,
    kyc_name    TEXT,
    kyc_id_tail TEXT,
    kyc_provider TEXT,
    kyc_verified_at TEXT,
    points      INTEGER NOT NULL DEFAULT 0,
    checkin_streak INTEGER NOT NULL DEFAULT 0,
    last_checkin TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_oauth (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL,   -- wechat | wecom | feishu | dingtalk
    open_id     TEXT NOT NULL,
    union_id    TEXT,
    bound_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider, open_id)
  );

  CREATE TABLE IF NOT EXISTS otp_store (
    key_name    TEXT PRIMARY KEY,
    code        TEXT NOT NULL,
    expire_at   INTEGER NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS oauth_states (
    state       TEXT PRIMARY KEY,
    provider    TEXT NOT NULL,
    expire_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS login_logs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT,
    user_name   TEXT,
    uid_seq     TEXT,
    method      TEXT NOT NULL,
    app_name    TEXT NOT NULL DEFAULT '本系统',
    ip          TEXT,
    user_agent  TEXT,
    status      TEXT NOT NULL DEFAULT 'success',  -- success | failed | disabled
    fail_reason TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS apps (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    icon        TEXT NOT NULL DEFAULT '📦',
    icon_bg     TEXT NOT NULL DEFAULT '#F0F0F0',
    description TEXT NOT NULL DEFAULT '',
    client_id   TEXT UNIQUE NOT NULL,
    client_secret TEXT NOT NULL,
    callback_url TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',  -- enabled | disabled | pending
    visible     INTEGER NOT NULL DEFAULT 0,        -- 用户端市场是否可见
    auth_users  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_app_auth (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    authed_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, app_id)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    token_hash  TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    scopes      TEXT NOT NULL DEFAULT '[]',        -- JSON array
    status      TEXT NOT NULL DEFAULT 'active',    -- active | revoked
    last_used_at TEXT,
    created_by  TEXT REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS env_config (
    key_name    TEXT PRIMARY KEY,
    value       TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS points_log (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta       INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS uid_seq (
    id INTEGER PRIMARY KEY AUTOINCREMENT
  );
`);

// ──────────────────────────────────────────
// 辅助：生成 uid_seq
// ──────────────────────────────────────────
function nextUidSeq() {
  const r = db.prepare('INSERT INTO uid_seq DEFAULT VALUES').run();
  return r.lastInsertRowid;
}

// ──────────────────────────────────────────
// 用户
// ──────────────────────────────────────────
const userStmts = {
  findById:      db.prepare('SELECT * FROM users WHERE id = ?'),
  findByEmail:   db.prepare('SELECT * FROM users WHERE email = ?'),
  findByPhone:   db.prepare('SELECT * FROM users WHERE phone = ?'),
  findAll:       db.prepare('SELECT * FROM users ORDER BY uid_seq ASC'),
  findByStatus:  db.prepare('SELECT * FROM users WHERE status = ? ORDER BY uid_seq ASC'),
  countAll:      db.prepare('SELECT COUNT(*) as n FROM users'),
  countVerified: db.prepare('SELECT COUNT(*) as n FROM users WHERE kyc_verified = 1'),
  countActive:   db.prepare("SELECT COUNT(*) as n FROM users WHERE status='active' AND date(last_checkin)=date('now')"),

  insert: db.prepare(`INSERT INTO users
    (id,uid_seq,name,email,phone,password_hash,role,admin_level,user_level,status)
    VALUES (@id,@uid_seq,@name,@email,@phone,@password_hash,@role,@admin_level,@user_level,@status)`),

  update: db.prepare(`UPDATE users SET
    name=@name, email=@email, phone=@phone, avatar=@avatar,
    status=@status, user_level=@user_level, admin_level=@admin_level,
    updated_at=datetime('now') WHERE id=@id`),

  updatePassword: db.prepare(`UPDATE users SET password_hash=?, updated_at=datetime('now') WHERE id=?`),

  setKyc: db.prepare(`UPDATE users SET
    kyc_verified=1, kyc_name=@name, kyc_id_tail=@id_tail,
    kyc_provider=@provider, kyc_verified_at=datetime('now'), updated_at=datetime('now')
    WHERE id=@user_id`),

  clearKyc: db.prepare(`UPDATE users SET
    kyc_verified=0, kyc_name=NULL, kyc_id_tail=NULL,
    kyc_provider=NULL, kyc_verified_at=NULL, updated_at=datetime('now')
    WHERE id=?`),

  addPoints: db.prepare('UPDATE users SET points = points + ?, updated_at=datetime(\'now\') WHERE id=?'),
  checkin:   db.prepare(`UPDATE users SET
    checkin_streak = checkin_streak + 1,
    last_checkin = date('now'),
    updated_at = datetime('now')
    WHERE id=?`),
  resetStreak: db.prepare(`UPDATE users SET checkin_streak=1, last_checkin=date('now'), updated_at=datetime('now') WHERE id=?`),
};

// ──────────────────────────────────────────
// OAuth 绑定
// ──────────────────────────────────────────
const oauthStmts = {
  findByProvider: db.prepare('SELECT u.* FROM users u JOIN user_oauth o ON u.id=o.user_id WHERE o.provider=? AND o.open_id=?'),
  findByUser:     db.prepare('SELECT * FROM user_oauth WHERE user_id=?'),
  bind:   db.prepare('INSERT OR REPLACE INTO user_oauth (id,user_id,provider,open_id,union_id) VALUES (?,?,?,?,?)'),
  unbind: db.prepare('DELETE FROM user_oauth WHERE user_id=? AND provider=?'),
};

// ──────────────────────────────────────────
// OTP
// ──────────────────────────────────────────
const otpStmts = {
  get:    db.prepare('SELECT * FROM otp_store WHERE key_name=?'),
  set:    db.prepare('INSERT OR REPLACE INTO otp_store (key_name,code,expire_at,attempts) VALUES (?,?,?,0)'),
  incAtt: db.prepare('UPDATE otp_store SET attempts=attempts+1 WHERE key_name=?'),
  del:    db.prepare('DELETE FROM otp_store WHERE key_name=?'),
  clean:  db.prepare('DELETE FROM otp_store WHERE expire_at < ?'),
};

// ──────────────────────────────────────────
// OAuth State
// ──────────────────────────────────────────
const stateStmts = {
  get:   db.prepare('SELECT * FROM oauth_states WHERE state=?'),
  set:   db.prepare('INSERT OR REPLACE INTO oauth_states (state,provider,expire_at) VALUES (?,?,?)'),
  del:   db.prepare('DELETE FROM oauth_states WHERE state=?'),
  clean: db.prepare('DELETE FROM oauth_states WHERE expire_at < ?'),
};

// ──────────────────────────────────────────
// 登录日志
// ──────────────────────────────────────────
const logStmts = {
  insert: db.prepare(`INSERT INTO login_logs (id,user_id,user_name,uid_seq,method,app_name,ip,user_agent,status,fail_reason)
    VALUES (@id,@user_id,@user_name,@uid_seq,@method,@app_name,@ip,@user_agent,@status,@fail_reason)`),
  findByUser:  db.prepare('SELECT * FROM login_logs WHERE user_id=? ORDER BY created_at DESC LIMIT ?'),
  findAll:     db.prepare('SELECT * FROM login_logs ORDER BY created_at DESC LIMIT 200'),
  findRecent:  db.prepare("SELECT * FROM login_logs WHERE date(created_at) >= date('now',?) ORDER BY created_at DESC"),
};

// ──────────────────────────────────────────
// 应用
// ──────────────────────────────────────────
const appStmts = {
  findAll:     db.prepare('SELECT * FROM apps ORDER BY created_at ASC'),
  findById:    db.prepare('SELECT * FROM apps WHERE id=?'),
  findEnabled: db.prepare("SELECT * FROM apps WHERE status='enabled' AND visible=1 ORDER BY created_at ASC"),
  insert: db.prepare(`INSERT INTO apps (id,name,icon,icon_bg,description,client_id,client_secret,callback_url,status,visible)
    VALUES (@id,@name,@icon,@icon_bg,@description,@client_id,@client_secret,@callback_url,@status,@visible)`),
  update: db.prepare(`UPDATE apps SET name=@name,icon=@icon,icon_bg=@icon_bg,description=@description,
    callback_url=@callback_url,status=@status,visible=@visible,updated_at=datetime('now') WHERE id=@id`),
  approve: db.prepare("UPDATE apps SET status='enabled',visible=1,updated_at=datetime('now') WHERE id=?"),
  isAuthed:    db.prepare('SELECT 1 FROM user_app_auth WHERE user_id=? AND app_id=?'),
  authUser:    db.prepare('INSERT OR IGNORE INTO user_app_auth (user_id,app_id) VALUES (?,?)'),
  revokeAuth:  db.prepare('DELETE FROM user_app_auth WHERE user_id=? AND app_id=?'),
  getUserApps: db.prepare('SELECT a.* FROM apps a JOIN user_app_auth ua ON a.id=ua.app_id WHERE ua.user_id=?'),
  incAuthUsers: db.prepare('UPDATE apps SET auth_users=auth_users+1 WHERE id=?'),
  decAuthUsers: db.prepare('UPDATE apps SET auth_users=MAX(0,auth_users-1) WHERE id=?'),
};

// ──────────────────────────────────────────
// API Keys
// ──────────────────────────────────────────
const apiKeyStmts = {
  findAll:    db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC'),
  findByHash: db.prepare('SELECT * FROM api_keys WHERE token_hash=? AND status=?'),
  insert: db.prepare(`INSERT INTO api_keys (id,name,token_hash,token_prefix,scopes,status,created_by)
    VALUES (@id,@name,@token_hash,@token_prefix,@scopes,@status,@created_by)`),
  revoke: db.prepare("UPDATE api_keys SET status='revoked' WHERE id=?"),
  touch:  db.prepare("UPDATE api_keys SET last_used_at=datetime('now') WHERE id=?"),
};

// ──────────────────────────────────────────
// 环境变量配置
// ──────────────────────────────────────────
const envStmts = {
  get:    db.prepare('SELECT value FROM env_config WHERE key_name=?'),
  getAll: db.prepare('SELECT key_name, value FROM env_config'),
  set:    db.prepare('INSERT OR REPLACE INTO env_config (key_name,value,updated_at) VALUES (?,?,datetime(\'now\'))'),
};

// ──────────────────────────────────────────
// 安装状态检测
// ──────────────────────────────────────────
function isSetupDone() {
  try {
    const row = envStmts.get.get('SETUP_DONE');
    return row?.value === '1';
  } catch (_) { return false; }
}

// ──────────────────────────────────────────
// 积分日志
// ──────────────────────────────────────────
const pointsStmts = {
  insert: db.prepare('INSERT INTO points_log (id,user_id,delta,reason) VALUES (?,?,?,?)'),
  findByUser: db.prepare('SELECT * FROM points_log WHERE user_id=? ORDER BY created_at DESC LIMIT 50'),
};

// ──────────────────────────────────────────
// 导出统一 store
// ──────────────────────────────────────────
module.exports = {
  db,
  nextUidSeq,
  isSetupDone,
  users: userStmts,
  oauth: oauthStmts,
  otp: otpStmts,
  state: stateStmts,
  logs: logStmts,
  apps: appStmts,
  apiKeys: apiKeyStmts,
  env: envStmts,
  points: pointsStmts,
};
