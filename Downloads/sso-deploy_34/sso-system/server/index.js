/**
 * 统一登录系统 - 主服务入口 v2.0
 */
require('dotenv').config();

// ── 第一步：把数据库中保存的环境变量注入 process.env ──
// 必须在所有其他 require 之前执行，确保 sms/email/oauth 等模块读到正确的值
(function loadEnvFromDb() {
  try {
    const Database = require('better-sqlite3');
    const path = require('path');
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/sso.db');
    const tmpDb = new Database(dbPath, { readonly: true });
    const rows = tmpDb.prepare(
      "SELECT key_name, value FROM env_config WHERE value IS NOT NULL AND value != ''"
    ).all();
    let count = 0;
    rows.forEach(({ key_name, value }) => {
      if (value && value.trim()) {
        process.env[key_name] = value;
        count++;
      }
    });
    tmpDb.close();
    if (count > 0) console.log(`[ENV] 从数据库加载了 ${count} 个环境变量，立即生效`);
  } catch (e) {
    if (!e.message?.includes('no such table') && !e.message?.includes('ENOENT')) {
      console.warn('[ENV] 数据库环境变量加载失败:', e.message);
    }
  }
})();

// ── 第二步：加载其他模块（此时 process.env 已含数据库中的值）──
const express   = require('express');
const session   = require('express-session');
const cors      = require('cors');
const path      = require('path');
const rateLimit = require('express-rate-limit');

const { isSetupDone } = require('./db');
const setupRoutes  = require('./setup');
const oauthRoutes  = require('./oauth');
const apiRoutes    = require('./api');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 基础中间件 ──
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Session ──
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-session-secret',
  resave: false, saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

// ── 安装守卫：未完成安装时，非 /setup 请求全部重定向 ──
app.use((req, res, next) => {
  if (
    req.path.startsWith('/setup') ||
    req.path.startsWith('/public') ||
    req.path === '/favicon.ico' ||
    req.path === '/'
  ) return next();
  if (!isSetupDone()) {
    if (req.path.startsWith('/api') || req.path.startsWith('/auth')) {
      return res.status(503).json({ error: '系统尚未完成初始化，请访问 /setup 完成安装' });
    }
    return res.redirect('/setup.html');
  }
  next();
});

// ── 注入 __SETUP_DONE__ 到 HTML ──
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    const fs = require('fs');
    const filePath = path.join(__dirname, '../public', req.path);
    if (fs.existsSync(filePath)) {
      let html = fs.readFileSync(filePath, 'utf8');
      html = html.replace('__SETUP_DONE__', isSetupDone() ? 'true' : 'false');
      return res.type('html').send(html);
    }
  }
  next();
});

// ── 路由 ──
app.use('/setup', setupRoutes);
app.use('/auth',  oauthRoutes);
app.use('/api',   apiRoutes);
app.use('/',      express.static(path.join(__dirname, '../public')));

// ── 根路由 ──
app.get('/', (req, res) => {
  if (!isSetupDone()) return res.redirect('/setup.html');
  res.redirect('/login.html');
});

// ── 启动 ──
app.listen(PORT, () => {
  console.log(`[SSO] 服务已启动：http://localhost:${PORT}`);
  console.log(`[SSO] 安装完成：${isSetupDone()}`);
});
