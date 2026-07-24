# QWQ SSO — 统一登录系统 v3.4.0.1

> 多渠道登录 · 用户/管理控制台 · 积分商城 · KYC 实名认证 · 开放 API · OIDC 身份提供方

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-3.4.0.1-blue.svg)](https://github.com/uesrbai/qwq-sso)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen.svg)](https://nodejs.org)

---

## ✨ 功能概览

### 登录方式（13 个平台）
| 类型 | 平台 |
|------|------|
| 账号密码 | 邮箱 + 密码 / 邮箱 + 验证码 / 手机 + 验证码 |
| 国内社交 | 微信公众号、企业微信、飞书、钉钉、抖音、快手、小红书、Bilibili、QQ |
| 国际平台 | Google、Apple、GitHub、Microsoft |

### 二级验证（2FA）
- **TOTP**：Google Authenticator / Authy 等兼容 App
- **Passkey**：WebAuthn 无密码硬件密钥（计划中）
- 管理员可配置是否开放、是否强制启用

### 用户端功能
- **首页**：签到（可配置周期/积分区间）
- **应用管理**：应用市场、已授权应用
- **积分商城**：商品兑换（生成兑换券）、盲盒、转账、兑换码、积分日志、我的兑换券
- **账号设定**：个人信息、时区、密码重置（验证码）、实名认证（KYC）、登录方式绑定
- **登录日志**：查看自己的登录记录（可导出，可配置保留天数）
- **公告查看**：弹窗确认后不再重复显示，公告更新后重新弹出

### 管理端功能
- **用户管理**：搜索、新建、详情、积分划转、重置密码、停用（含级别保护）
- **应用管理**：CRUD、审核通过/拒绝、删除（清除所有授权）
- **登录日志**：按状态筛选、导出 CSV
- **调用日志**：入站（外部调用本系统）/ 出站（本系统调用外部）统计与记录
- **商城管理**：商品（含盲盒配置）、兑换码（作废/撤销）、兑换记录、积分配置
- **系统配置**：所有三方服务商环境变量（按三方登录/消息通知/实名认证/支付/系统与页脚分类，侧边栏二级导航）、页脚动态配置、登录协议编辑、三方轮询策略
- **API 调用**：密钥管理（`sk_live_`/`sk_test_` 双前缀分离、测试密钥永久可查看+沙盒模拟数据、实际密钥强制可信 IP、全量历史记录不因撤销而消失）、接口文档、调用测试
- **等级管理**：普通用户/管理员两组等级，支持任意等级新增/编辑/删除（等级下有用户时禁止删除），用户等级以 `U数字`/`A数字`（如 U3、A1）标识符暴露给 API，管理端等级列表不直接展示该标识符
- **公告发布**：富文本编辑器（粗体/斜体/字号/图片/链接/视频），支持 API 发布

### 消息发送
- **短信 / 邮件**：统一通过 [QWQ Message](https://github.com/uesrbai/qwq-message) 分发中心发送，
  本系统不直接对接服务商；服务商账号、模板、轮询与故障转移都在分发中心配置
- **KYC 轮询**：Didit（每月 500 次免费）/ Stripe Identity / 阿里云 / 火山引擎
- **策略**：最少调用优先 / 顺序优先 / 只开放一个 / 用户自选

### 页脚与版权
- 版权行 `Copyright © 2026 QWQ INC.` 固定，遵循 MIT 协议不可删除
- 管理端可动态添加/删除备案号、许可证、认证等页脚项目
- 分发人字段支持超链接跳转

---

## 🚀 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（首次启动通过 /setup 向导完成）
cp .env.example .env

# 3. 启动
npm start
```

访问 `http://localhost:3000`，按向导完成初始化。

### Zeabur 一键部署

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com)

1. Fork 本仓库
2. 在 Zeabur 新建项目 → 从 GitHub 导入
3. 设置必要环境变量（`JWT_SECRET`、`SESSION_SECRET`）
4. 访问 `https://your-domain.zeabur.app/setup` 完成初始化

---

## 🗂️ 目录结构

```
├── server/
│   ├── index.js      # Express 入口，页脚注入，env 从数据库加载
│   ├── api.js        # 全部 REST 接口
│   ├── auth.js       # JWT 鉴权 + requireAuth/Admin/ApiKey
│   ├── db.js         # SQLite 数据库层（better-sqlite3）
│   ├── oauth.js      # 13 个平台 OAuth 回调
│   ├── message.js    # 短信 + 邮件（统一调 QWQ Message 分发中心）
│   ├── kyc.js        # KYC（Didit/Stripe/阿里云/火山引擎 + 轮询）
│   ├── poller.js     # 通用服务商轮询模块
│   └── setup.js      # 安装向导后端
├── public/
│   ├── login.html          # 登录页（动态平台显示）
│   ├── dashboard.html      # 用户端 + 管理端控制台
│   ├── login-success.html  # 登录成功中间页（Token 验证）
│   └── setup.html          # 安装向导
├── .env.example      # 环境变量模板
├── API-docs.md       # 开放接口文档
└── package.json
```

---

## 🔧 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Node.js 18+ · Express 4 · better-sqlite3 |
| 前端 | 原生 HTML/CSS/JS（单文件，无构建工具）|
| 数据库 | SQLite（`data/sso.db`，自动创建）|
| 认证 | JWT · bcryptjs · WebAuthn（Passkey）|
| 部署 | Zeabur / 任意 Node.js 环境 |

---

## 📡 开放 API

所有接口以 `Bearer sk_live_xxxx` 或 `Bearer sk_test_xxxx` 鉴权。

| 接口 | 说明 |
|------|------|
| `GET /api/v1/auth/verify` | 验证用户 Token |
| `GET /api/v1/user/me` | 获取用户信息 |
| `GET /api/v1/coupon/verify` | 核验兑换券 |
| `POST /api/v1/coupon/use` | 核销兑换券 |
| `GET /api/v1/redeem/verify` | 核验兑换码 |

详见 [API-docs.md](./API-docs.md)。

---

## ⚖️ 关于我们与许可协议

我们是位于美国特拉华州的 **QWQ INC.（库哇库股份有限公司）**，其在中国的共同开发者是**海南省儋州市许白网络文化传媒有限公司（Hainan Xubai MediaNet Co., Ltd）**。

本项目遵循 **MIT 协议**（Massachusetts Institute of Technology License）。这是一种源自麻省理工学院的宽松型开源许可证，以简洁、自由度高著称。它允许任何人免费使用、复制、修改、合并、发布、分发、再授权甚至销售软件及其文档，唯一要求是在软件及相关文档中保留原作者的版权声明和许可声明。

我公司与共同开发者公司依法享有该项目的原始著作权利与相关技术成果，任何人对其使用、复制、修改、合并、发布、分发、再授权甚至销售软件及其文档时，都应该保留我们在其项目中的相关版权信息与著作权信息，您包括但不限于围绕于不能做出修改版权或著作信息等举动。

我方及其关联方有权对其作品保有著作权利，以及其他的维护我方权益的权利。

我方仅保证相关软件按照原样提供，如分发人将其分发后再修改作为非法用途的，将不为我方责任。

如您使用、复制、修改、合并、发布、分发、再授权甚至销售软件及其文档的方式对本项目做出举动，则代表您同意 MIT 协议与我们给出的限制条件。否则，请购买商业授权版。

---

## 📞 联系我们

我们有代为配置（部署）服务，如果您不会配置，或者想要更为实惠的云服务（服务器、域名、CDN 等）资源，请咨询微信客服：

> 微信扫码咨询客服（企业微信 · 微信客服）

如您有其他问题，可以加入官方微信交流群了解详情：

> QWQ-SSO 官方群（企业微信群）

---

## 📄 License

```
MIT License
Copyright (c) 2026 QWQ INC. & Hainan Xubai MediaNet Co., Ltd
```
