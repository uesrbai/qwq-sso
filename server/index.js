/**
 * 统一登录系统 - 主服务入口 v2.0
 */
require('dotenv').config();

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
  // 放行安装相关路径
  if (
    req.path.startsWith('/setup') ||
    req.path.startsWith('/api/setup') ||
    req.path === '/health' ||
    req.path === '/favicon.ico'
  ) return next();

  if (!isSetupDone()) {
    // API 请求返回 JSON 错误
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
      return res.status(503).json({ error: '系统尚未完成初始化，请访问 /setup 完成安装' });
    }
    // 页面请求重定向
    return res.redirect('/setup');
  }
  next();
});

// ── Rate limit（生产环境防暴力破解）──
if (process.env.NODE_ENV === 'production') {
  app.use('/api/email/login',    rateLimit({ windowMs: 15*60*1000, max: 20 }));
  app.use('/api/sms/send',       rateLimit({ windowMs: 60*1000,    max: 3  }));
  app.use('/api/email/send-code',rateLimit({ windowMs: 60*1000,    max: 3  }));
}

// ── 静态文件（setup.html 也在 public/ 里）──
app.use(express.static(path.join(__dirname, '../public')));

// ── 路由 ──
app.use('/setup', setupRoutes);
app.use('/auth',  oauthRoutes);
app.use('/api',   apiRoutes);

// ── 健康检查 ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', setup: isSetupDone(), time: new Date().toISOString() });
});

// ── 页面路由 ──
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

// 登录页：注入 setup 状态，未配置时开启模拟登录
app.get('/login.html', (req, res) => {
  const fs   = require('fs');
  const done = isSetupDone();
  let html   = fs.readFileSync(path.join(__dirname, '../public/login.html'), 'utf8');
  // 注入全局变量（在 <head> 末尾前插入）
  const inject = `<script>window.__SETUP_DONE__=${done ? 'true' : 'false'};</script>`;
  html = html.replace('</head>', inject + '\n</head>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.listen(PORT, () => {
  const setupDone = isSetupDone();
  console.log(`
╔══════════════════════════════════════════════╗
║      统一登录系统 SSO v2.0 已启动            ║
╠══════════════════════════════════════════════╣
║  地址:    http://localhost:${String(PORT).padEnd(17)}║
${setupDone
  ? `║  登录页:  http://localhost:${PORT}/login.html    ║\n║  控制台:  http://localhost:${PORT}/dashboard     ║`
  : `║  ⚠️  首次安装，请访问:                          ║\n║  安装向导: http://localhost:${PORT}/setup          ║`
}
╚══════════════════════════════════════════════╝`);
});

module.exports = app;
