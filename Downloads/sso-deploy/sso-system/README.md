# 统一登录系统 (Unified SSO)

支持微信公众号 / 企业微信 / 飞书 / 钉钉 / 邮箱密码 / 短信验证码的一站式登录方案。

## 目录结构

```
sso-system/
├── server/
│   ├── index.js      # 主入口 (Express)
│   ├── oauth.js      # OAuth 登录路由 (微信/企微/飞书/钉钉)
│   ├── api.js        # REST API (邮箱/短信/用户)
│   ├── auth.js       # JWT 签发与验证
│   ├── sms.js        # 短信服务 (火山引擎/阿里云)
│   ├── email.js      # 邮件服务 (SMTP)
│   └── store.js      # 内存存储 (生产替换为 Redis + DB)
├── public/
│   ├── login.html         # 登录页面
│   └── login-success.html # 登录成功页面
├── .env.example      # 环境变量模板
├── package.json
└── README.md
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填写各平台的 AppID / Secret 等
```

### 3. 启动

```bash
# 开发模式（验证码打印到控制台，不真实发送）
NODE_ENV=development npm run dev

# 生产模式
npm start
```

访问 http://localhost:3000/login.html

---

## 各平台配置说明

### 微信公众号

1. 登录 [微信公众平台](https://mp.weixin.qq.com)
2. 开发 → 基本配置 → 获取 AppID 和 AppSecret
3. 网页授权域名 → 填写你的服务器域名（不含 http://）
4. 在公众号设置 → 功能设置 → 网页授权域名

```env
WECHAT_APP_ID=wx_xxxxx
WECHAT_APP_SECRET=xxxxx
WECHAT_REDIRECT_URI=https://yourdomain.com/auth/wechat/callback
```

> ⚠️ 微信公众号 OAuth 需要服务器绑定域名，本地开发请用 ngrok 或内网穿透

### 企业微信自建应用

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin)
2. 应用管理 → 自建 → 创建应用
3. 获取：企业ID (CorpID)、AgentID、应用 Secret

```env
WECOM_CORP_ID=ww_xxxxx
WECOM_AGENT_ID=1000001
WECOM_APP_SECRET=xxxxx
WECOM_REDIRECT_URI=https://yourdomain.com/auth/wecom/callback
```

### 飞书自建应用

1. 登录 [飞书开放平台](https://open.feishu.cn)
2. 创建企业自建应用
3. 应用凭证 → 获取 App ID 和 App Secret
4. 安全设置 → 添加重定向 URL

```env
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
FEISHU_REDIRECT_URI=https://yourdomain.com/auth/feishu/callback
```

### 钉钉应用

1. 登录 [钉钉开放平台](https://open.dingtalk.com)
2. 应用开发 → 企业内部开发 → 创建应用
3. 凭证与基础信息 → 获取 ClientID 和 ClientSecret
4. 权限管理 → 开通 `Contact.User.Read` 权限

```env
DINGTALK_CLIENT_ID=xxxxx
DINGTALK_CLIENT_SECRET=xxxxx
DINGTALK_REDIRECT_URI=https://yourdomain.com/auth/dingtalk/callback
```

### 短信 - 火山引擎

1. 登录 [火山引擎控制台](https://console.volcengine.com)
2. 短信服务 → 创建应用 → 申请短信签名 + 模板
3. 短信模板示例：`您的验证码是${code}，${minute}分钟内有效。`
4. 访问控制 → API 密钥 → 获取 AccessKey

```env
SMS_PROVIDER=volcengine
VOLCENGINE_ACCESS_KEY_ID=AK_xxxxx
VOLCENGINE_ACCESS_KEY_SECRET=xxxxx
VOLCENGINE_SMS_SIGN=你的签名
VOLCENGINE_SMS_TEMPLATE_ID=SMS_xxxxx
```

### 短信 - 阿里云

1. 登录 [阿里云控制台](https://console.aliyun.com)
2. 短信服务 → 国内消息 → 签名管理 + 模板管理
3. RAM 控制台 → 创建 AccessKey

```env
SMS_PROVIDER=aliyun
ALIYUN_ACCESS_KEY_ID=xxxxx
ALIYUN_ACCESS_KEY_SECRET=xxxxx
ALIYUN_SMS_SIGN=你的签名
ALIYUN_SMS_TEMPLATE=SMS_xxxxx
```

### 邮箱 SMTP

支持 QQ 邮箱、网易邮箱、企业邮箱等：

```env
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your@qq.com
SMTP_PASS=授权码（非QQ密码）
```

---

## API 文档

### 短信验证码

```
POST /api/sms/send
{ "phone": "13800138000" }

POST /api/sms/verify
{ "phone": "13800138000", "code": "123456" }
→ { "token": "eyJ...", "user": {...} }
```

### 邮箱验证码

```
POST /api/email/send-code
{ "email": "user@example.com" }

POST /api/email/verify-code
{ "email": "user@example.com", "code": "123456" }
→ { "token": "eyJ...", "user": {...} }
```

### 邮箱密码

```
POST /api/email/register
{ "email": "user@example.com", "password": "123456", "name": "张三" }

POST /api/email/login
{ "email": "user@example.com", "password": "123456" }
→ { "token": "eyJ...", "user": {...} }
```

### 用户信息（需 Bearer Token）

```
GET /api/user/me
Authorization: Bearer eyJ...
→ { "user": { "id", "name", "email", "phone", "oauth", ... } }
```

### 验证 Token（供第三方应用接入 SSO 使用）

```
POST /api/auth/verify
Authorization: Bearer eyJ...
→ { "valid": true, "user": {...} }
```

---

## 生产环境部署

### 数据存储替换

当前 `store.js` 使用内存存储，重启后数据丢失。生产环境推荐：

- **用户数据** → MySQL / PostgreSQL / MongoDB
- **验证码 OTP** → Redis（设置 TTL 自动过期）
- **OAuth State** → Redis

### 安全加固

- 所有 OAuth 回调必须使用 HTTPS
- `JWT_SECRET` 使用 64 位随机字符串
- 启用 rate limiting（推荐 `express-rate-limit`）
- 短信 OTP 发送间隔限制（60秒）
- 验证码最多尝试次数限制（5次）

### Zeabur / Docker 部署

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "server/index.js"]
```

---

## 接入第三方应用（SSO 模式）

其他应用可通过以下方式验证用户：

```javascript
// 前端：重定向到统一登录
window.location.href = 'https://sso.yourdomain.com/login.html?redirect=https://app.yourdomain.com';

// 登录成功后拿到 token，调用验证接口
const res = await fetch('https://sso.yourdomain.com/api/auth/verify', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` }
});
const { valid, user } = await res.json();
```
