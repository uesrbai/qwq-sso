# 统一登录系统 SSO v2.0

多渠道登录 + 用户/管理控制台 + 积分商城 + 开放 API

## 功能

- **登录方式**：邮箱密码、邮箱验证码、短信验证码、微信/企业微信/飞书/钉钉 OAuth
- **用户端**：首页签到、积分商城、应用市场、账号设定（含实名认证）
- **管理端**：用户管理、应用管理、商城管理、等级管理、API Key、环境变量、登录日志
- **开放 API**：Bearer API Key 鉴权，供第三方系统对接

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，修改 JWT_SECRET 和 SESSION_SECRET

# 3. 初始化数据库（创建管理员账号）
npm run init

# 4. 启动
npm start
```

管理员账号：`xurui@xurui365.top`

访问：`http://localhost:3000`

## 部署

详见 [部署文档](#部署到服务器) 或参考 `API文档.md`。

## 技术栈

- **后端**：Node.js + Express + better-sqlite3
- **前端**：原生 HTML/CSS/JS（单文件，无构建工具）
- **数据库**：SQLite（`data/sso.db`，自动创建）

## 目录结构

```
├── server/
│   ├── index.js     # 入口
│   ├── api.js       # 所有接口
│   ├── auth.js      # JWT 鉴权
│   ├── db.js        # 数据库层
│   ├── init.js      # 初始化脚本
│   ├── oauth.js     # OAuth 回调
│   ├── sms.js       # 短信服务
│   └── email.js     # 邮件服务
├── public/
│   ├── login.html       # 登录页
│   ├── dashboard.html   # 控制台
│   └── login-success.html
├── .env.example     # 环境变量模板
├── API文档.md       # 接口文档
└── package.json
```
