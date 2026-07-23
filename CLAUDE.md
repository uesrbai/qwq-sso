# CLAUDE.md — 项目交接文档

> 本文档面向接手此项目的 Claude Code（或任何后续开发者）。之前的开发全部在 Claude.ai 对话中完成，本文件把散落在多轮对话里的架构决策、命名约定、已知坑点系统性整理出来，避免重复踩坑或推翻已有设计。

---

## 项目是什么

**QWQ SSO** — 统一登录系统，当前版本 **v3.3.10.1**。

- 部署地址：`https://qwqsso.zeabur.app`（Zeabur 托管）
- GitHub：`https://github.com/uesrbai/qwq-sso`
- 版权方：QWQ INC.（美国特拉华州），中国共同开发者：海南省儋州市许白网络文化传媒有限公司
- 许可证：MIT License（版权行 `Copyright © 2026 QWQ INC.` 不可删除/修改，遵循协议见 README.md 底部）

功能范围：13 个三方登录平台、积分商城（含盲盒）、KYC 实名认证（4 服务商轮询）、短信/邮件轮询发送、开放 API（含测试密钥沙盒模式）、动态页脚配置、等级管理、公告系统等。详见 `README.md` 的完整功能清单。

---

## 技术栈与硬约束

- **后端**：Node.js + Express 4 + `better-sqlite3`（同步 SQLite，无 ORM）
- **前端**：原生 HTML/CSS/JS，**单文件、无构建工具、无框架**。`dashboard.html` 一个文件裸装了用户端+管理端全部页面和逻辑（约 5000+ 行），`login.html`、`login-success.html`、`setup.html` 各自独立
- **数据库**：SQLite 文件 `data/sso.db`，**没有迁移工具**，schema 变更靠 `db.js` 里成堆的 `try { db.exec('ALTER TABLE ... ADD COLUMN ...') } catch(_) {}` 语句（IF NOT EXISTS 语义模拟），新增字段必须照抄这个模式，不要引入迁移框架
- **认证**：JWT（用户/管理员）+ API Key SHA256 哈希（第三方系统）
- **部署**：Zeabur，`NODE_ENV` 环境变量**不代表**是否发送真实短信/邮件——判断逻辑是"是否配置了对应服务商的环境变量"，这一点被坑过一次（见下方"已修复的重大 bug"）

---

## 目录结构

```
server/
├── index.js      # 入口。启动时从数据库加载 env 注入 process.env（必须在其他 require 之前执行）
├── api.js        # 几乎所有 REST 接口都在这一个文件里（1700+ 行）
├── auth.js       # JWT 签发/验证 + requireAuth/requireAdmin/requireApiKey 中间件
├── db.js         # 唯一持有 Database 实例的地方，导出 { db, users, oauth, otp, ... } 等 prepared statement 集合
├── oauth.js      # 【消费方】本系统去登录 13 个平台的 OAuth 回调路由
├── provider.js   # 【提供方】第三方"用 QWQ SSO 登录"：OIDC 授权码流程 + PKCE
│                 #   ⚠️ 和 oauth.js 方向相反，别搞混
├── message.js    # 短信 + 邮件：统一调 QWQ Message 分发中心的单一接口
│                 #   （v3.3.3 起替代原 sms.js / email.js，两者已删除）
├── kyc.js        # KYC 四服务商（Didit/Stripe/阿里云/火山引擎）+ 轮询
├── poller.js     # 通用轮询选择器。⚠️ 现在只有 kyc.js 在用，但别删——
│                 #   message.js 仍靠它的 recordCall() 记出站调用统计
└── setup.js      # 首次安装向导后端

public/
├── login.html          # 登录页，动态显示已配置的登录平台
├── dashboard.html       # 用户端 + 管理端一体化控制台（巨型单文件）
├── authorize.html       # OIDC 授权确认页（第三方登录时的"是否同意"界面）
├── login-success.html   # 登录成功中间页，5秒倒计时+Token验证展示
└── setup.html            # 首次安装向导前端
```

---

## ⚠️ 关键约定（务必遵守，否则会重复引入 bug）

### 1. `db.js` 的导出方式 — 曾经踩过的坑

```js
// db.js 结尾
module.exports = { db, nextUidSeq, isSetupDone, users, oauth, otp, state, logs, apps, apiKeys, env, points };
```

**`db` 只是导出对象里的一个属性，不是整个模块。** 曾经在 `poller.js` 里写成：

```js
const db = require('./db');       // ❌ 错误：拿到的是整个 exports 对象
db.prepare(...)                    // TypeError: db.prepare is not a function
```

正确写法必须解构：

```js
const { db } = require('./db');   // ✅ 正确
```

**任何新文件要用数据库，一律 `const { db } = require('./db')`，不要 `const db = require('./db')`。**

### 2. 环境变量加载顺序

`index.js` 顶部有一段立即执行函数 `loadEnvFromDb()`，用 `better-sqlite3` 开一个独立的只读连接，把数据库 `env_config` 表的值注入 `process.env`——**这段代码必须在所有其他 `require` 之前执行**，否则 `api.js`、`sms.js` 等模块在 `require` 时就已经读取了空的 `process.env`，导致管理端配置了变量也不生效。

同时这段加载逻辑是"**只填补空缺，不覆盖已存在的环境变量**"（Zeabur 平台变量优先于数据库存的值），这是为了避免数据库里一个错误的 `JWT_SECRET` 覆盖掉 Zeabur 上正确配置的值导致所有 token 集体失效。

管理端 `POST /admin/env` 保存时会**同步写入 `process.env`**，做到不重启立即生效。

### 3. 短信/邮件是否真发送 —— 别用 NODE_ENV 判断

早期版本用 `process.env.NODE_ENV !== 'production'` 来判断是否只打印验证码到控制台。**这是个重大 bug**：Zeabur 默认不设 `NODE_ENV=production`，导致线上一直走"只打印不发送"分支，用户永远收不到验证码。

现在的正确逻辑是**检测消息分发中心是否已配置**（v3.3.3 起）：

```js
const { isConfigured } = require('./message');
if (isConfigured()) { /* 真发 */ } else { /* 只打印，响应体带 dev: true */ }
// isConfigured() 就是 !!(QWQ_MESSAGE_URL && QWQ_MESSAGE_KEY)
```

`message.js`/`kyc.js` 里任何新增通道都要遵循这个模式，不要引入 NODE_ENV 判断。

### 4. JWT 过期保护

`auth.js` 的 `signToken()` 对 `JWT_EXPIRES_IN` 做了防呆：如果这个环境变量被误配置成一个 `<=60` 的纯数字（比如管理员手滑填了 `1`），会强制回退到 `7d` 并打印警告，防止所有新签发的 token 秒过期导致集体登录闪退。**这段防呆逻辑不要删。**

### 5. 密码字段命名

数据库字段是 `password_hash`，不是 `password`。`bcryptjs` 加密强度是 `12`（`bcrypt.hash(pw, 12)`），全项目统一，不要改成别的强度。

### 6. UID 格式

用户对外展示的编号是 `#00001` 这种 5 位补零格式，来自 `uid_seq` 字段（自增整数）。前端格式化函数是 `fmtUid(seq)`，在 `dashboard.html` 里定义，不要重复造轮子。

### 7. 等级标识符 `level_tag`（U/A + 数字）

这是**给 API 和用户字段用的**，格式规则：
- 普通用户：`U` + 一位数字（`U1`~`U9`，数字越小等级越高）
- 管理员：`A` + 一位数字（`A1`~`A9`，数字越小权限越大）

**注意**：这个标识符**不应该**直接展示在管理端「等级管理」页面的卡片上（那里只显示 `Lv.数字`），只应该出现在：
- 用户详情面板（作为辅助小标签，带 tooltip 说明"API 请求标识符"）
- `/v1/users`、`/v1/users/:uid`、`/v1/auth/verify` 等开放 API 的返回字段
- `GET /v1/users?level_tag=U3` 查询参数

等级本身存于 `user_levels` 表（`grp`/`num`/`name`/`badge`/`descr`/`perms`），支持任意等级的增删改（有用户占用的等级禁止删除），详见 `api.js` 的 `/admin/levels` 系列接口。

### 8. API Key 双前缀 + 沙盒模式

- `sk_live_xxxx`：实际密钥，**必须配置可信 IP** 才能调用（未配置返回 403），只在创建那一刻完整显示一次
- `sk_test_xxxx`：测试密钥，明文存库（`token_plain` 字段），可在密钥列表随时反复查看完整值；默认不校验来源 IP（除非管理员主动为它指定了具体 IP）；调用任何 `/v1/*` 接口都返回预设的**沙盒 mock 数据**（`_sandbox: true`），不碰真实数据库

`requireApiKey` 中间件（`auth.js`）里 `req.isSandbox` 标记了这次请求是否是测试密钥，`api.js` 里每个 `/v1/*` 接口开头都有 `if (req.isSandbox) return res.json(SANDBOX.xxx())` 的判断，新增开放接口时要照做。

**密钥历史永不真删除**——`DELETE /admin/api-keys/:id` 只是把 `status` 改成 `revoked`，无论测试还是实际密钥，历史记录都要能查到（管理端「显示全部历史」默认开启）。

### 9. 页脚渲染方式

页脚不是写死在 HTML 里的，是**服务端字符串替换**注入的：

- `public/*.html` 里埋了占位符 `__FOOTER_HTML__`（目前在各页面的 `</body>` 前，页脚整页居底显示）
- `index.js` 的 HTML 响应中间件用正则把占位符替换成 `buildFooterHtml()` 生成的真实内容
- 版权行 `Copyright © 2026 QWQ INC.` 是**硬编码不可配置**的，分发人名称/链接来自 `FOOTER_DISTRIBUTOR` / `FOOTER_DISTRIBUTOR_URL` 环境变量
- 其他页脚项目（备案号、许可证等）是**动态扫描**所有 `FOOTER_*` 环境变量渲染的，管理端有个"页脚信息管理"面板支持增删（生成变量名规则：`FOOTER_<自定义后缀>`，勾选超链接则额外生成 `FOOTER_<后缀>_URL`）
- 版本号那行 `Powered by QWQ SSO v3.2.4` 链接指向 `https://github.com/uesrbai/qwq-sso`，**硬编码不可配置**

**页脚位置的当前实际状态（2026-07-20 核实）**：`dashboard.html:1861` 的占位符包在 `<div id="site-footer-placeholder">` 里，位置在 `</div><!-- /content -->` **之前**，也就是已经是"功能内容区居底"那一版。`login.html:1637` 和 `login-success.html:358` 则是裸占位符放在页面末尾（这两个页面没有 `.content` 滚动容器，效果等同整页居底，符合预期）。

（`setup.html` 早期漏埋了占位符导致安装向导页没页脚，v3.2.4 已补上，位置同样在 `</body>` 前。新增页面时记得别再漏。）

### 10. ⚠️ secret 字段的掩码绝不能当成真值提交（v3.3.3.1 修复的严重 bug）

管理端「系统配置」里 `secret: true` 的字段，未点👁展开时输入框的 `value` 是
`'•'.repeat(n)`（`dashboard.html` 渲染处）。而 `saveAllEnv()` 原本直接读 `inputEl.value` 提交——
**结果是在系统配置页点一次保存，所有已配置的密钥会被整串圆点覆盖**：
微信/飞书/钉钉 AppSecret、`JWT_SECRET`、各家 KYC 密钥、`QWQ_MESSAGE_KEY` 全部报废。
症状极具迷惑性：页面上依然显示「已配置」，但实际发请求时报
`Cannot convert argument to a ByteString ... value of 8226`（8226 就是 `•`）。

现在有三道防线，改动这块时不要拆掉任何一道：
1. `onEnvInput()` 给字段打 `v.dirty = true`，`saveAllEnv()` **只提交被用户真正改过的 secret 字段**
2. `saveAllEnv()` 里 `isMaskedValue()` 拦截纯圆点串
3. 后端 `POST /admin/env` 再判一次，圆点串一律拒绝写入并记 warn

`renderEnvPage()` 从服务端重新载入时会把所有 `dirty` 复位。

### 11. 系统配置页（原"环境变量"，已改名）

管理端左侧菜单「环境变量」已重命名为「系统配置」。这个页面的 UI 结构是**左侧竖排分类导航（模仿主菜单栏风格）+ 右侧配置卡片**，不是早期版本的顶部横向 tab。一级分类（三方登录/消息通知/实名认证/支付/系统与页脚）点击可展开二级子菜单（具体到每个服务商）。`ENV_GROUPS` 数组里每一项现在都带 `category` 字段用于分类归属，新增服务商配置时要记得打上正确的 category。

---

## 数据库表清单（截至 v3.2.0）

核心表：`users`、`user_oauth`、`otp_store`、`oauth_states`、`login_logs`、`apps`、`user_app_auth`、`api_keys`、`env_config`、`points_log`、`uid_seq`

商城相关：`shop_goods`、`shop_records`、`redeem_codes`、`redeem_records`、`feature_quota`、`shop_config`、`blind_box_rewards`、`user_coupons`

其他：`provider_stats`（三方服务商调用统计）、`api_call_logs`（入站/出站调用日志）、`user_levels`（等级管理）

OIDC 相关（v3.3.0 新增）：`oauth_auth_codes`（授权码，10 分钟单次使用）、`oauth_access_tokens`（访问令牌，只存 sha256）、`user_app_auth.scope`（用户对该应用实际授权了哪些 scope）

字段增补一律走 `db.js` 里的 `try { ALTER TABLE ... } catch(_) {}` 模式，**不要**假设某个字段一定存在，写查询时留意 `COALESCE` 或默认值兜底。

### ⚠️ ALTER TABLE 必须写在建表语句「之后」

这是 v3.3.0 修掉的一个存量 bug，务必注意：原先 18 条 `ALTER TABLE` 全部排在 `db.exec()` 建表块**之前**，
全新数据库首次启动时表还不存在 → 所有 ALTER 被 `catch(_) {}` 静默吞掉 → 字段全部缺失；
要等第二次启动（表已建好）才补上。表现为**首次安装后功能残缺、重启一次又自己好了**，极难排查。

现在 `db.js` 有一个明确的「迁移」区块位于建表之后，**新增字段请加在那个区块里**，
文件顶部只留了一行注释提醒不要往那儿加。

---

## 已知未完成 / 可能需要继续打磨的部分

> 以下状态已于 2026-07-20 逐条对照代码核实完毕，不再是"待核实"。

1. ✅ **2FA（TOTP）v3.3.6 + Passkey v3.3.8 均已实现**。`server/twofa.js` 用 Node
   内置 crypto 实现 RFC 6238（HMAC-SHA1 / 30s / 6 位），已用官方测试向量校验。流程：账号设定→登录方式绑定
   里绑定（出密钥 + otpauth，手动录入；**未做二维码**，见下）→ 校验一次动态码→下发 10 个一次性恢复码。
   开了 2FA 的用户密码/验证码登录后进「二段」：后端发 5 分钟中间态令牌（`stage:'2fa'`），
   前端浮层输入动态码或恢复码，调 `/api/2fa/login-verify` 换正式 token。
   管理员可用 `TWOFA_REQUIRED_LEVELS`（如 `A1,A2`）强制某些等级必须开启（`mustSetup2fa`）。
   ⚠️ **所有登录路径都过 2FA 门**：密码/验证码/注册走 `finishLogin`；第三方 OAuth 登录
   （`oauth.js` 的 `loginSuccess`）开了 2FA 的用户会跳 `/login.html?tfa=<中间态令牌>` 走二段
   （v3.3.10.1 补，之前 OAuth 绕过 2FA）；Passkey 本身即强认证，直接发 token 不再叠 2FA。
   **二维码（v3.3.7 补齐）**：`public/qr-mini.js` 是自研纯 JS QR 编码器（字节模式/纠错 M/版本 1~10），
   **在浏览器本地生成，密钥不出客户端**。刻意不用 CDN 二维码库——那会把外部 JS 注入已登录的控制台
   （能读 localStorage 里的 JWT），是供应链风险。这个文件同源、随仓库走。
   编码器用 RFC 官方向量之外还做了双重校验：jsqr 往返解码 + 与成熟库 qrcode 逐模块 diff=0。
   超出容量时 `svg()` 返回 null，前端回退到手动录入密钥。
   ⚠️ `twofa_secret` 是敏感字段，`safeUser()` 已剔除，任何接口都不下发。

   **Passkey（WebAuthn / FIDO2，v3.3.8）**：`server/passkey.js` + `public/webauthn-glue.js`。
   密码学验证交给成熟库 **`@simplewebauthn/server`（新依赖）**，不手写。绑定在账号设定→登录方式绑定，
   登录页有「用 Passkey 登录」按钮（浏览器支持时才显示）。凭据存 `webauthn_credentials` 表，
   `counter` 防重放。Passkey 登录本身即强认证，直接发 token 不再走 2FA。
   RP ID / origin 从 `BASE_URL` 推导，**必须与实际访问域名一致**，否则浏览器拒绝；WebAuthn 要求 HTTPS（localhost 例外）。
   **完整仪式已用 Node 软件认证器（真实 P-256 + CBOR/COSE + 签名，`scratchpad/soft-authenticator.js`）
   端到端跑通**：注册/登录/counter 防重放/challenge 校验共 8 项，走真实 @simplewebauthn 校验。
   ⚠️ **RP ID/origin 必须与浏览器实际域名一致**——v3.3.9.1 修：`rpConfig` 改为从**本次请求**的
   `X-Forwarded-Host`/`Host` + `X-Forwarded-Proto` 推导（不再写死 BASE_URL），并 `app.set('trust proxy', true)`。
   之前写死 BASE_URL 会导致「用别的域名访问」或「反代下 protocol 变 http」时 origin 不匹配 → 添加失败。
   浏览器胶水层 `webauthn-glue.js` 按 `@simplewebauthn/browser` 的输出格式手写（base64url↔ArrayBuffer + 序列化），
   同源不走 CDN（已登录页面注入外部 JS 是供应链风险）。
2. ✅ **登录协议富文本编辑器：v3.3.10 已实现**。管理端「登录协议」页（服务条款 / 隐私政策两个 tab），
   富文本编辑用原生 `contenteditable` + `execCommand`（粗体/斜体/标题/列表/链接/图片/视频，无第三方依赖）。
   存 `site_documents` 表（key=terms/privacy）。**保存时服务端 `sanitizeHtml` 净化**：去掉
   `<script>/<style>/<iframe>` 等危险标签、`on*` 事件属性、`javascript:` 协议（内容虽由管理员撰写，
   仍防管理员账号被盗的存储型 XSS）。登录页那两个原本 `href="#"` 的死链接改为 `showDoc()` 弹窗展示，
   走公开接口 `GET /api/public/document/:key`。
   ⚠️ 净化是正则实现（无 DOMPurify，避免引 jsdom），挡住了主要向量但不是完备沙箱；只有 Lv.2+ 能编辑。
3. ✅ **邮箱域名白名单/黑名单：v3.3.2 已实现**。两个环境变量控制：
   `EMAIL_DOMAIN_MODE`（`off`/`whitelist`/`blacklist`）+ `EMAIL_DOMAIN_LIST`（逗号分隔，不带 @，子域自动匹配）。

   **重要语义（改之前先理解）**：策略只作用于「新账号进入系统」的三个入口——`/email/send-code`、
   `/email/register`、`/email/verify-code` 里自动建号那一支。**已存在账号的密码登录不拦截**，
   否则管理员事后加一条黑名单就会把已有用户直接锁死在门外，那是误伤不是策略。
   另外**列表为空时策略自动失效**，防止误配 `whitelist` + 空列表把全站锁死。

   前端 `login.html` 的两个「账号所属域」下拉框现在由 `/api/public/email-domain-policy` 驱动：
   白名单模式只给允许的域（去掉「不限」和「自定义」），黑名单模式摘掉被禁的域，并显示提示。
   注意前端只是提前告知，**真正的拦截在后端**。
4. ✅ **用户端登录日志导出：v3.3.4 已实现**。两个环境变量控制：
   `LOGINDATE_DAY`（展示/导出的天数窗口，默认 30，夹在 1~3650）+ `LOGINDATE_EXPORT`（是否允许用户导出，
   `off`/`0`/`false`/`no` 关闭，默认开）。用户端首页「近期登录记录」表内显示最近 20 条、标注「近 N 天共 M 条」，
   导出按钮走 `GET /api/user/login-logs/export` 下载整个窗口的 CSV（带 UTF-8 BOM，CSV 字段做了逗号/引号转义）。
   开关关闭时前端隐藏按钮、后端也返回 403。管理端「系统配置 → 登录日志」可配。
   （管理端自己的全量日志导出 `exportLogsCSV()` 一直都在，与此独立。）
5. ✅ **公告系统：v3.3.9 已实现**。`announcements` 表 + `announcement_reads`（记已读时的公告版本）。
   管理端「公告管理」CRUD（Lv.2）；用户进首页（`loadHome`）本会话首次弹待读公告，逐条「我知道了」标记已读。
   **「更新后重弹」机制**：已读时存下公告的 `updated_at`，编辑内容会刷新 `updated_at`（用**毫秒精度** strftime %f，
   避免"同一秒内编辑+已读"漏判），`read_version !== updated_at` 即重弹。停用不弹、urgent 排前、删除连带清理已读记录。
6. **短信发送 KYC 认证链接**：`sendSmsCode(phone, redirectUrl)` 目前是把完整 URL 塞进验证码模板的占位符里发送，**这依赖短信服务商预先审核一个"通知类"模板**（不是标准的验证码模板），实际生产环境需要管理员在短信服务商后台单独报备这个模板，代码里只是尽力发送、失败会被 catch 并返回 `failed: <原因>`

---

## 消息发送：全部走 QWQ Message 分发中心（v3.3.3 起）

本系统**不再直接对接任何短信/邮件服务商**。原来的 `sms.js`（火山引擎/阿里云/腾讯云）和
`email.js`（Zeabur Email/SMTP，含多 SMTP 轮询）已删除，改为 `message.js` 调一个接口：

```
POST {QWQ_MESSAGE_URL}/api/v1/send
Authorization: Bearer {QWQ_MESSAGE_KEY}
{ group, to, subject, content, templateCode?, variables? }
```

分发中心：https://github.com/uesrbai/qwq-message

配置项（管理端「系统配置 → 消息分发（QWQ Message）」）：

| 变量 | 说明 |
|---|---|
| `QWQ_MESSAGE_URL` | 分发中心根地址，代码会自动去掉结尾斜杠 |
| `QWQ_MESSAGE_KEY` | `qwq_live_`（生产，支持 IP 白名单）/ `qwq_test_`（测试） |
| `QWQ_MESSAGE_SMS_GROUP` | 短信通道组标识 |
| `QWQ_MESSAGE_EMAIL_GROUP` | 邮件通道组标识 |
| `QWQ_MESSAGE_SMS_HUB_TEMPLATE` | 分发中心「模板管理」里**自建模板**的编号，走 `template` 字段 |
| `QWQ_MESSAGE_SMS_TEMPLATE` | **服务商**后台已审核的模板号，走 `templateCode` 字段 |
| `QWQ_MESSAGE_SMS_VAR` | 模板占位符变量名，默认 `code` |

⚠️ **上面两个模板变量是完全不同的东西，这里踩过坑**：分发中心自建模板的编号
（如 `sso-sms-code`）如果填进 `QWQ_MESSAGE_SMS_TEMPLATE`，会被当成服务商模板号
原样透传给火山引擎/阿里云，对方查无此模板 → 报 `RE:0005 模板错误`。
自建模板必须填 `QWQ_MESSAGE_SMS_HUB_TEMPLATE`。两者二选一，自建模板优先。

要点：
- **服务商账号、模板、轮询、故障转移全在分发中心那边**，本系统不再管这些。
  管理端「三方服务商轮询策略」里短信/邮件两栏已移除，**只剩 KYC**
- 分发中心返回 HTTP 200 但 `success:false` 时**也算失败**，错误原因（`detail`）会透传给调用方
- 出站调用统计仍记在 `provider_stats`，标识是 `qwq_message`；
  旧的 `sms_*`/`email_*` 历史记录保留可查，管理端标签标注了「（历史）」
- `sendSmsCode` / `sendEmailCode` / `sendEmail` **函数签名保持不变**，调用方无需改动。
  实名认证提醒那处 `sendSmsCode(phone, redirectUrl)` 传的是链接而非验证码，行为照旧

---

## 第三方接入的两条路（v3.3.0 起）

**别再把开放 API 当成"第三方登录"用**——它们解决的是不同问题：

| | 开放 API（`/api/v1/*`） | OIDC 登录（`/oauth/*`） |
|---|---|---|
| 凭据 | `sk_live_` API Key | `client_id` + `client_secret` |
| 用户参与 | 无，后台直接查库 | 有，跳转 + 授权确认页 |
| 数据范围 | 管理员给的 scope | 用户逐项勾选同意的 scope |
| 实现位置 | `api.js` | `provider.js` |

v3.3.0 之前**只有前者**，所以"第三方登录"实际上是"第三方读库"——用户全程没参与。
`apps` 表的 `client_id`/`client_secret`/`callback_url` 三个字段从很早就存在，但 `callback_url`
在此之前**从未被任何代码读取过**，是纯装饰。

设计要点（改动前先理解，别退回去）：
- `id_token` 用 **HS256 + client_secret** 签名，故意不引入 RSA/JWKS，省掉密钥管理
- `redirect_uri` 必须与 `apps.callback_url` **完全一致**，不匹配时**绝不回跳**（防钓鱼），直接 400
- **最小化披露**：未授权的字段在 `id_token` 和 `userinfo` 里根本不出现，不是给 null
- `kyc` scope 即使授权，姓名也只给脱敏结果（张三丰 → 张**），完整姓名永不下发
- 撤销授权会连带吊销已发出的令牌（`api.js` 的 `DELETE /apps/:id/auth`）

### 管理端「应用管理」的接入凭据（v3.3.3.6 补齐）

第三方要接 OIDC，管理员必须能拿到 `client_id` + `client_secret`。`client_secret` 是**明文**存在
`apps.client_secret`（不像 API Key 是哈希），本可显示。但早期管理端**任何地方都不显示它**，
导致第三方无法调 `/oauth/token` 换令牌，接入根本无法完成——这就是用户说的「应用管理没做完」。

现在：新建应用后弹出凭据面板，编辑弹窗里有「🔑 接入凭据」区块（`appCredentialsHtml()`），
展示 client_id、client_secret（👁 打码可展开、可复制）、四个端点地址、发起示例，
并提供「重新生成密钥」（`POST /admin/apps/:id/regenerate-secret`，旧密钥立即失效）。

⚠️ 同批修掉一个 bug：`POST /admin/apps` 原本写死 `status:'pending'`，忽略前端传的
「直接启用」，导致管理员自建应用永远是待审核、无法用于 OIDC 授权（authorize 会因未启用而拒绝）。
现在按传入的 status 建（合法值 enabled/pending/disabled，默认 enabled）。

### 多标识符登录（v3.3.5）

登录页的「账号所属域」下拉已删除（纯输入辅助，用户嫌鸡肋）。现在登录框是**单个自动识别**的
账号输入，支持四种标识符：邮箱（含 `@`）、手机号（`1[3-9]\d{9}`）、UID（`#00001`/`00001`/`1`）、用户名。

- 后端 `resolveUser(identifier)`（`api.js`）按 邮箱→手机号→UID→用户名 顺序解析；
  用户名可能重名，命中多个返回 `AMBIGUOUS`，接口提示「改用邮箱/手机号/UID 登录」
- **密码登录**四种标识符都行：前端发 `POST /api/account/login {account,password}`；
  旧路径 `/api/email/login` + `{email}`/`{phone}` 字段仍兼容
- **验证码登录**只支持邮箱/手机号（验证码要有下发渠道），前端 `isEmailStr`/`isPhoneStr`
  自动判断走 `/email/*` 还是 `/sms/*`；填用户名/UID 会提示改用密码登录
- 报错文案统一为「账号或密码不正确」，不再区分邮箱/手机号，也不泄露账号是否存在
- 注册面板未动（仍是邮箱/手机号 + 域名策略下拉，域名白/黑名单 v3.3.2 那套只作用于注册）

### 登录后跳回授权页（`next` 的传递，v3.3.3.5 修）

第三方跳来授权时若用户未登录，`authorize.html` 会带 `?next=<授权页完整地址>` 跳到 `login.html`。
登录完成后要跳回这个 `next` 继续授权。两条登录路径的处理方式不同，别改坏：

- **邮箱/手机 密码或验证码登录**（纯前端）：`login.html` 的 `redirect()` 直接读 URL 里的
  `next`（`safeNext()` 只放行站内相对路径）跳回，不经中间页
- **第三方 OAuth 登录（微信/企业微信/飞书… 全部 13 家）**：要经过「本站→平台→回调」一圈
  服务端跳转，`next` 没法一路带在 URL 上。做法是 `oauth.js` 有个 `router.use` 中间件把进入
  `/auth/*` 时的 `?next=` 存进 **session**（`postLoginNext`），`loginSuccess()` 再取出，
  拼进 `/login-success.html?...&next=`，中间页拿到 `next` 就跳过倒计时直接跳回
- **扫码登录**（微信/企业微信）：二维码直接指向平台、不经过 `/auth/<平台>` 入口，所以
  `login.html` 载入时若有 `next` 会先 `fetch('/auth/stash-next?next=...')` 把它存进 session
- 三处都只接受站内相对路径（`/` 开头、非 `//`），防止 token 被带去外站（开放重定向）

---

## 交接核查时新发现的问题（2026-07-20，均未擅自修改，待用户确认）

1. 🔴 **`server/init.js` 硬编码了超级管理员明文密码**（第 15-17 行，`ADMIN_EMAIL` / `ADMIN_PASSWORD`）。仓库是公开的，这等于把线上超管凭据公开了。建议改成读 `INIT_ADMIN_EMAIL` / `INIT_ADMIN_PASSWORD` 环境变量，未配置时随机生成并打印一次；**并且要先去线上把这个账号的密码改掉**，改代码本身不能撤销已泄露的事实
2. 🟡 **`server/store.js` 是死代码**。它是早期的内存版 Map 存储（用户/OTP/OAuth state），已被 `db.js` 的 SQLite 实现完全取代，全项目无任何文件 `require` 它。留着容易让后续开发者误用（它的字段名是 `passwordHash` 驼峰，和数据库的 `password_hash` 不一致，一旦误用会静默出错）。建议删除
3. ✅ **版本号脱节已修复**（v3.2.4）。此前 tag 已走到 v3.2.3，但 `package.json` / `server/index.js` 页脚 / `README.md` 徽章都还停在 3.2.0——说明前几次发版只打 tag 没同步改代码。**发版时这四处必须一起改**：`package.json` 的 `version` / `server/index.js:130` 的 `versionLink` / `README.md` 标题 + 徽章 / 本文件开头的版本号
4. ✅ **「每次启动作废所有 API Key」已删除**（v3.3.0）。原代码 `UPDATE api_keys SET status='revoked'
   WHERE status='active'` 注释标称"一次性历史迁移"，实际没有任何条件保护、每次启动都执行——
   Zeabur 每次部署都重启，等于每次发版所有第三方密钥集体失效。这就是"API Key 老是莫名其妙失效"的原因。
   **将来若真需要一次性迁移，必须带版本标记，不要写成无条件语句**
5. ✅ **KYC 的管理端配置项与代码读取的变量名对不上（v3.3.3 已修）**。管理端「KYC · 阿里云」
   面板写的是 `ALIYUN_KYC_ACCESS_KEY_ID`，但 `kyc.js` 读的是 `ALIYUN_ACCESS_KEY_ID`（短信那套通用凭据）；
   火山引擎同理（`VOLC_KYC_*` vs `VOLCENGINE_*`）。**结果是在 KYC 面板里填的密钥从来没生效过**，
   KYC 能跑只是因为恰好借用了短信的凭据。现在改成「优先专用 AK，回退通用 AK」。
   注意这个坑正好挡在删短信配置的路上——如果当时直接删掉短信配置组，KYC 会当场失效
6. 🟡 **`server/init.js` 的 `ENV_KEYS` 预置列表已经落后**。里面没有 Didit KYC、Zeabur Email（`ZEABUR_EMAIL_TOKEN`）、以及所有 `FOOTER_*` 相关的键。新增服务商时除了 `ENV_GROUPS`（`dashboard.html`），也要记得同步这个列表

---

## Git / 部署注意事项

- 远程仓库：`https://github.com/uesrbai/qwq-sso.git`
- **该仓库启用了 GitHub Secret Scanning + Tag Protection**，历史上有一次真实的腾讯云 Secret ID 被误提交进某次历史（具体在哪个 commit 未彻底定位清楚），导致后续所有推送/打 tag 反复被拦截
- 用户最终采用的工作流：**每次发布新版本时 `rm -rf .git && git init` 重新开始**，不保留连续提交历史，只保留 tag 快照（v2.0.0、v3.0.0、v3.1.0、v3.2.0 等），`git push --force` 覆盖 main 分支
- **不要尝试"保留完整连续 git 历史"的方案**——之前尝试过，因为主目录曾经有个误建的 `.git`（在 `C:\Users\xurui` 根目录，混入了大量个人文件和 Codex 运行时缓存），排查耗费大量精力，最终放弃，回到"每次重新初始化"的简单方案
- 部署路径确认：本地解压 zip 到某个 `sso-deploy_XX/sso-system` 目录后，直接在**该子目录**里 `git init`，不要在上层目录操作
- Zeabur 会自动从 GitHub 拉取部署，`git push` 成功后无需额外操作

---

## 交互习惯（供后续沟通参考）

- 项目所有者主要用中文交流，代码注释、commit message、用户可见文案统一用简体中文
- 每次代码改动后期望：语法校验（`node --check`）→ 打包成 zip → 用 `present_files` 交付
- 每次改动后期望立刻收到可复制粘贴的 git 提交命令，格式基本固定：
  ```bash
  cd 项目目录
  rm -rf .git
  git init
  git add .
  git commit -m "描述"
  git remote add origin https://github.com/uesrbai/qwq-sso.git
  git branch -M main
  git push -u origin main --force
  git tag vX.Y.Z
  git push origin vX.Y.Z
  ```
- **版本号规则（2026-07-20 用户明确，按此执行，不用每次再问）**：

  | 段位 | 谁来决定 |
  |---|---|
  | 一级 `X.0.0` | **只有用户本人能改**，绝不主动动 |
  | 二级 `3.X.0` | 可以提议，但要先问过用户 |
  | 三级 `3.3.X` | **每次改动都加**，不用问 |
  | 四级 `3.3.1.X` | 本次**只是打补丁修 bug** 时用第四段，而不是第三段 |

  版本号要同步到**四处**：`package.json` 的 `version`、`server/index.js` 里 `versionLink` 的
  `Powered by QWQ SSO vX.Y.Z`、`README.md` 标题 + 徽章、`CLAUDE.md` 开头的当前版本。
  改完打 tag 并 `git push origin vX.Y.Z`。历史上出过只打 tag 不改代码导致脱节（tag 到 v3.2.3 而代码停在 3.2.0）。

- ⚠️ **改文件一律用编辑器工具，不要用 PowerShell 的 `Get-Content`/`Set-Content` 做替换**：
  本机是 Windows PowerShell 5.1，`Get-Content` 默认按 ANSI 代码页读取，读 UTF-8 中文文件会得到乱码，
  再 `Set-Content -Encoding utf8` 写回就把整个文件毁了（README/CLAUDE.md/index.js 都是满篇中文，一改就炸）。
  2026-07-20 踩过一次，靠 `git checkout --` 才救回来。
