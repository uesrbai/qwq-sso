/**
 * 统一登录系统 - 主服务入口 v2.0
 */
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cors    = require('cors');
const path    = require('path');
const rateLimit = require('express-rate-limit');

const oauthRoutes = require('./oauth');
const apiRoutes   = require('./api');

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
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 7*24*60*60*1000 },
}));

// ── Rate limit（生产环境防暴力破解）──
if (process.env.NODE_ENV === 'production') {
  app.use('/api/email/login',    rateLimit({ windowMs: 15*60*1000, max: 20 }));
  app.use('/api/sms/send',       rateLimit({ windowMs: 60*1000,    max: 3  }));
  app.use('/api/email/send-code',rateLimit({ windowMs: 60*1000,    max: 3  }));
}

// ── 静态文件 ──
app.use(express.static(path.join(__dirname, '../public')));

// ── 路由 ──
app.use('/auth', oauthRoutes);
app.use('/api',  apiRoutes);

// ── 健康检查 ──
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── 页面路由 ──
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../public/dashboard.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')));

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║      统一登录系统 SSO v2.0 已启动            ║
╠══════════════════════════════════════════════╣
║  地址:    http://localhost:${PORT}               ║
║  登录页:  http://localhost:${PORT}/login.html    ║
║  控制台:  http://localhost:${PORT}/dashboard     ║
╠══════════════════════════════════════════════╣
║  初次使用请先运行: npm run init              ║
╚══════════════════════════════════════════════╝`);
});

module.exports = app;
