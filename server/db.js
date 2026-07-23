/**
 * 数据库层 - better-sqlite3
 * 所有数据持久化到 data/sso.db
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// index.js 的 loadEnvFromDb() 一直是认 DB_PATH 的，这里以前写死成 data/sso.db，
// 导致一旦配置了 DB_PATH，两边会读写不同的库文件。统一以 DB_PATH 为准。
const DB_FILE  = process.env.DB_PATH || path.join(__dirname, '../data/sso.db');
const DATA_DIR = path.dirname(DB_FILE);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);

// WAL 模式提升并发性能
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ⚠️ 字段迁移（ALTER TABLE）统一放在建表之后，见本文件下方「迁移」区块。
// 不要往这里加 ALTER —— 此处表还没建，ALTER 会被 catch 静默吞掉。

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

// API 调用日志表（入站+出站）
try {
  db.exec(`CREATE TABLE IF NOT EXISTS api_call_logs (
    id          TEXT PRIMARY KEY,
    direction   TEXT NOT NULL DEFAULT 'inbound',
    method      TEXT, path TEXT, provider TEXT,
    status      INTEGER, success INTEGER NOT NULL DEFAULT 1,
    error_msg   TEXT, duration_ms INTEGER, ip TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
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

  -- ── QWQ SSO 作为身份提供方（OIDC Provider）── --
  -- 授权码：单次使用、10 分钟过期，绑定 client_id + redirect_uri + PKCE
  CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    code            TEXT PRIMARY KEY,
    app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri    TEXT NOT NULL,
    scope           TEXT NOT NULL DEFAULT 'openid',
    nonce           TEXT,
    code_challenge  TEXT,
    challenge_method TEXT,
    used            INTEGER NOT NULL DEFAULT 0,
    expires_at      INTEGER NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 访问令牌：不存明文，只存 sha256
  CREATE TABLE IF NOT EXISTS oauth_access_tokens (
    token_hash  TEXT PRIMARY KEY,
    app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope       TEXT NOT NULL DEFAULT 'openid',
    expires_at  INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
// 迁移：给已存在的表补字段（已存在则被 catch 跳过）
//
// ⚠️ 必须放在上面的建表语句「之后」。
// 历史上这一整块被放在建表之前，导致全新数据库首次启动时所有 ALTER
// 都因「表不存在」而静默失败，字段要等到第二次启动才补上——
// 表现为首次安装后功能残缺、重启一次又莫名其妙好了。新增字段请加在本区块内。
// ──────────────────────────────────────────
try { db.exec('ALTER TABLE users ADD COLUMN can_rename INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec('ALTER TABLE users ADD COLUMN can_change_email INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec('ALTER TABLE users ADD COLUMN can_change_phone INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec("ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'auto'"); } catch(_) {}
// 记录用户对某个应用实际授权了哪些 scope（老数据默认给最小集）
try { db.exec("ALTER TABLE user_app_auth ADD COLUMN scope TEXT NOT NULL DEFAULT 'openid profile'"); } catch(_) {}
// 2FA（TOTP 二次验证）
try { db.exec('ALTER TABLE users ADD COLUMN twofa_enabled INTEGER NOT NULL DEFAULT 0'); } catch(_) {}
try { db.exec('ALTER TABLE users ADD COLUMN twofa_secret TEXT'); } catch(_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS twofa_recovery_codes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code_hash TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(_) {}
// Passkey（WebAuthn 凭据）
try { db.exec(`CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, cred_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT,
  name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT
)`); } catch(_) {}
// 公告系统
try { db.exec(`CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT 'info',              -- info | warn | urgent
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))  -- 内容更新会刷新，用于"更新后重弹"
)`); } catch(_) {}
// 用户对公告的已读状态：记录已读时公告的 updated_at，之后公告再更新则重弹
try { db.exec(`CREATE TABLE IF NOT EXISTS announcement_reads (
  user_id TEXT NOT NULL, announcement_id TEXT NOT NULL,
  read_version TEXT NOT NULL,                       -- 已读时公告的 updated_at
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, announcement_id)
)`); } catch(_) {}
// 站点法律文档（服务条款 / 隐私政策），富文本 HTML，管理端可编辑
try { db.exec(`CREATE TABLE IF NOT EXISTS site_documents (
  doc_key TEXT PRIMARY KEY,                          -- terms | privacy
  title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(_) {}
try { db.exec("ALTER TABLE shop_goods ADD COLUMN redeem_mode TEXT NOT NULL DEFAULT 'code'"); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN allow_instant INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN redirect_url TEXT'); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN allow_transfer INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN transfer_fee INTEGER NOT NULL DEFAULT 0'); } catch(_) {}
try { db.exec("ALTER TABLE api_keys ADD COLUMN key_type TEXT NOT NULL DEFAULT 'live'"); } catch(_) {}
try { db.exec("ALTER TABLE api_keys ADD COLUMN trusted_ips TEXT"); } catch(_) {}
try { db.exec("ALTER TABLE api_keys ADD COLUMN token_plain TEXT"); } catch(_) {} // 仅测试密钥明文保存，供随时查看
try { db.exec('ALTER TABLE shop_goods ADD COLUMN is_blind_box INTEGER NOT NULL DEFAULT 0'); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN open_instantly INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec("ALTER TABLE apps ADD COLUMN status TEXT NOT NULL DEFAULT 'enabled'"); } catch(_) {}

// 注：这里曾有一行 UPDATE api_keys SET status='revoked' WHERE status='active'，
// 注释标称「一次性历史迁移」，实际没有任何条件保护，等于每次服务启动都作废全部密钥
// （Zeabur 每次部署都重启 → 每次发版第三方密钥集体失效）。v3.3.0 已删除。
// 若将来真需要一次性迁移，请用带版本标记的方式，不要写成无条件语句。

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
  findByUidSeq:  db.prepare('SELECT * FROM users WHERE uid_seq = ?'),
  findByName:    db.prepare('SELECT * FROM users WHERE name = ?'),   // 用户名可能重名，用 .all()
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

  // 2FA
  set2fa:     db.prepare("UPDATE users SET twofa_enabled=?, twofa_secret=?, updated_at=datetime('now') WHERE id=?"),
};

// ──────────────────────────────────────────
// 2FA 恢复码 / Passkey 凭据
// ──────────────────────────────────────────
const twofaStmts = {
  insertCode:  db.prepare('INSERT INTO twofa_recovery_codes (id,user_id,code_hash) VALUES (?,?,?)'),
  listCodes:   db.prepare('SELECT * FROM twofa_recovery_codes WHERE user_id=? AND used=0'),
  findCode:    db.prepare('SELECT * FROM twofa_recovery_codes WHERE user_id=? AND code_hash=? AND used=0'),
  useCode:     db.prepare('UPDATE twofa_recovery_codes SET used=1 WHERE id=?'),
  clearCodes:  db.prepare('DELETE FROM twofa_recovery_codes WHERE user_id=?'),
  countCodes:  db.prepare('SELECT COUNT(*) AS n FROM twofa_recovery_codes WHERE user_id=? AND used=0'),
};

const webauthnStmts = {
  insert:      db.prepare(`INSERT INTO webauthn_credentials (id,user_id,cred_id,public_key,counter,transports,name)
    VALUES (@id,@user_id,@cred_id,@public_key,@counter,@transports,@name)`),
  listByUser:  db.prepare('SELECT * FROM webauthn_credentials WHERE user_id=? ORDER BY created_at DESC'),
  findByCredId:db.prepare('SELECT * FROM webauthn_credentials WHERE cred_id=?'),
  updateCounter: db.prepare("UPDATE webauthn_credentials SET counter=?, last_used_at=datetime('now') WHERE id=?"),
  rename:      db.prepare('UPDATE webauthn_credentials SET name=? WHERE id=? AND user_id=?'),
  remove:      db.prepare('DELETE FROM webauthn_credentials WHERE id=? AND user_id=?'),
  countByUser: db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id=?'),
};

// ──────────────────────────────────────────
// 公告
// ──────────────────────────────────────────
const announcementStmts = {
  findAll:    db.prepare('SELECT * FROM announcements ORDER BY created_at DESC'),
  findActive: db.prepare("SELECT * FROM announcements WHERE active=1 ORDER BY (level='urgent') DESC, created_at DESC"),
  findById:   db.prepare('SELECT * FROM announcements WHERE id=?'),
  // updated_at 用毫秒精度（strftime %f），避免"同一秒内更新+已读"导致重弹漏判
  insert:     db.prepare("INSERT INTO announcements (id,title,content,level,active,updated_at) VALUES (@id,@title,@content,@level,@active,strftime('%Y-%m-%d %H:%M:%f','now'))"),
  update:     db.prepare("UPDATE announcements SET title=@title, content=@content, level=@level, active=@active, updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=@id"),
  setActive:  db.prepare("UPDATE announcements SET active=?, updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?"),
  remove:     db.prepare('DELETE FROM announcements WHERE id=?'),
  // 已读状态
  getRead:    db.prepare('SELECT read_version FROM announcement_reads WHERE user_id=? AND announcement_id=?'),
  markRead:   db.prepare(`INSERT INTO announcement_reads (user_id,announcement_id,read_version) VALUES (?,?,?)
    ON CONFLICT(user_id,announcement_id) DO UPDATE SET read_version=excluded.read_version, read_at=datetime('now')`),
  clearReads: db.prepare('DELETE FROM announcement_reads WHERE announcement_id=?'),
};

// ──────────────────────────────────────────
// 站点法律文档
// ──────────────────────────────────────────
const documentStmts = {
  get:    db.prepare('SELECT * FROM site_documents WHERE doc_key=?'),
  upsert: db.prepare(`INSERT INTO site_documents (doc_key,title,content,updated_at) VALUES (?,?,?,datetime('now'))
    ON CONFLICT(doc_key) DO UPDATE SET title=excluded.title, content=excluded.content, updated_at=datetime('now')`),
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
  // 用户自己在指定天数窗口内的登录记录（用户端展示 + 导出）
  findByUserRecent: db.prepare("SELECT * FROM login_logs WHERE user_id=? AND date(created_at) >= date('now',?) ORDER BY created_at DESC LIMIT 2000"),
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
  getUserApps: db.prepare(`SELECT a.*, ua.scope AS granted_scope, ua.authed_at
    FROM apps a JOIN user_app_auth ua ON a.id=ua.app_id WHERE ua.user_id=?`),
  incAuthUsers: db.prepare('UPDATE apps SET auth_users=auth_users+1 WHERE id=?'),
  decAuthUsers: db.prepare('UPDATE apps SET auth_users=MAX(0,auth_users-1) WHERE id=?'),
};

// ──────────────────────────────────────────
// OIDC Provider（本系统作为身份提供方）
// ──────────────────────────────────────────
const idpStmts = {
  findAppByClientId: db.prepare('SELECT * FROM apps WHERE client_id=?'),
  grantedScope:      db.prepare('SELECT scope FROM user_app_auth WHERE user_id=? AND app_id=?'),
  upsertGrant:       db.prepare(`INSERT INTO user_app_auth (user_id,app_id,scope) VALUES (?,?,?)
    ON CONFLICT(user_id,app_id) DO UPDATE SET scope=excluded.scope`),

  insertCode: db.prepare(`INSERT INTO oauth_auth_codes
    (code,app_id,user_id,redirect_uri,scope,nonce,code_challenge,challenge_method,expires_at)
    VALUES (@code,@app_id,@user_id,@redirect_uri,@scope,@nonce,@code_challenge,@challenge_method,@expires_at)`),
  findCode:   db.prepare('SELECT * FROM oauth_auth_codes WHERE code=?'),
  useCode:    db.prepare('UPDATE oauth_auth_codes SET used=1 WHERE code=?'),
  // 同一应用+用户的其余未用码一并作废（防止授权码囤积）
  killCodes:  db.prepare('UPDATE oauth_auth_codes SET used=1 WHERE app_id=? AND user_id=? AND used=0'),
  cleanCodes: db.prepare('DELETE FROM oauth_auth_codes WHERE expires_at < ?'),

  insertToken: db.prepare(`INSERT INTO oauth_access_tokens (token_hash,app_id,user_id,scope,expires_at)
    VALUES (?,?,?,?,?)`),
  findToken:   db.prepare('SELECT * FROM oauth_access_tokens WHERE token_hash=?'),
  cleanTokens: db.prepare('DELETE FROM oauth_access_tokens WHERE expires_at < ?'),
  // 用户撤销授权时，连带吊销该应用已发出的令牌
  killTokens:  db.prepare('DELETE FROM oauth_access_tokens WHERE app_id=? AND user_id=?'),
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
  idp: idpStmts,
  twofa: twofaStmts,
  webauthn: webauthnStmts,
  announcements: announcementStmts,
  documents: documentStmts,
  apiKeys: apiKeyStmts,
  env: envStmts,
  points: pointsStmts,
};
