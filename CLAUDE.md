# CLAUDE.md — 项目交接文档

> 本文档面向接手此项目的 Claude Code（或任何后续开发者）。之前的开发全部在 Claude.ai 对话中完成，本文件把散落在多轮对话里的架构决策、命名约定、已知坑点系统性整理出来，避免重复踩坑或推翻已有设计。

---

## 项目是什么

**QWQ SSO** — 统一登录系统，当前版本 **v3.2.0**。

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
├── oauth.js      # 13 个平台的 OAuth 回调路由
├── sms.js        # 短信三服务商（火山引擎/阿里云/腾讯云）+ 轮询
├── email.js      # 邮件（Zeabur Email/SMTP）+ 轮询
├── kyc.js        # KYC 四服务商（Didit/Stripe/阿里云/火山引擎）+ 轮询
├── poller.js     # 通用轮询选择器，被 sms/email/kyc 共用
└── setup.js      # 首次安装向导后端

public/
├── login.html          # 登录页，动态显示已配置的登录平台
├── dashboard.html       # 用户端 + 管理端一体化控制台（巨型单文件）
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

现在的正确逻辑是**检测对应服务商的必需环境变量是否已配置**：

```js
const hasEmailProvider = !!(process.env.ZEABUR_EMAIL_TOKEN || process.env.SMTP_HOST);
if (hasEmailProvider) { /* 真发 */ } else { /* 只打印，响应体带 dev: true */ }
```

`sms.js`/`email.js`/`kyc.js` 里任何新增服务商都要遵循这个模式，不要引入 NODE_ENV 判断。

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
- 版本号那行 `Powered by QWQ SSO v3.2.0` 链接指向 `https://github.com/uesrbai/qwq-sso`，**硬编码不可配置**

**页脚位置的当前实际状态（2026-07-20 核实）**：`dashboard.html:1861` 的占位符包在 `<div id="site-footer-placeholder">` 里，位置在 `</div><!-- /content -->` **之前**，也就是已经是"功能内容区居底"那一版。`login.html:1637` 和 `login-success.html:358` 则是裸占位符放在页面末尾（这两个页面没有 `.content` 滚动容器，效果等同整页居底，符合预期）。

⚠️ **`setup.html` 里根本没有 `__FOOTER_HTML__` 占位符**，所以首次安装向导页是没有页脚的。不确定是有意为之还是遗漏，改之前先问用户。

### 10. 系统配置页（原"环境变量"，已改名）

管理端左侧菜单「环境变量」已重命名为「系统配置」。这个页面的 UI 结构是**左侧竖排分类导航（模仿主菜单栏风格）+ 右侧配置卡片**，不是早期版本的顶部横向 tab。一级分类（三方登录/消息通知/实名认证/支付/系统与页脚）点击可展开二级子菜单（具体到每个服务商）。`ENV_GROUPS` 数组里每一项现在都带 `category` 字段用于分类归属，新增服务商配置时要记得打上正确的 category。

---

## 数据库表清单（截至 v3.2.0）

核心表：`users`、`user_oauth`、`otp_store`、`oauth_states`、`login_logs`、`apps`、`user_app_auth`、`api_keys`、`env_config`、`points_log`、`uid_seq`

商城相关：`shop_goods`、`shop_records`、`redeem_codes`、`redeem_records`、`feature_quota`、`shop_config`、`blind_box_rewards`、`user_coupons`

其他：`provider_stats`（三方服务商调用统计）、`api_call_logs`（入站/出站调用日志）、`user_levels`（等级管理）

字段增补一律走 `db.js` 里的 `try { ALTER TABLE ... } catch(_) {}` 模式，**不要**假设某个字段一定存在，写查询时留意 `COALESCE` 或默认值兜底。

---

## 已知未完成 / 可能需要继续打磨的部分

> 以下状态已于 2026-07-20 逐条对照代码核实完毕，不再是"待核实"。

1. **2FA / Passkey**：**未实现**。全项目 grep `2fa|totp|passkey|webauthn` 零命中，`README.md` 里的"计划中"属实，是纯空白待办
2. **登录协议富文本编辑器**：**未实现**。零命中，管理端没有对应子菜单
3. **邮箱域名白名单/黑名单**：**确认只有前端、后端完全没接**。`login.html:1044` 的 `#acct-domain` 下拉框目前只是个"帮你把 @gmail.com 拼到输入框后面"的输入辅助，选项是硬编码的四个常见域 + 自定义，既没有"白名单/黑名单"模式概念，`api.js` 里也搜不到任何 domain 相关校验（grep `domain` 零命中）。要做需要：新增 `EMAIL_DOMAIN_MODE`(off/white/black) + `EMAIL_DOMAIN_LIST` 两个环境变量，前端下拉框改为从后端拉取，后端在注册/发码接口里强制校验
4. **用户端登录日志导出**：**未实现**。`LOGINDATE_DAY`/`LOGINDATE_EXPORT` 两个变量在代码里零命中。目前只有**管理端**有登录日志导出（`dashboard.html:1137` 的 `exportLogsCSV()`，实现在 `dashboard.html:4969` 起），用户端没有任何日志导出入口，也没有 30 天默认窗口的逻辑
5. **公告系统**：**未实现**。`announcements` 表不存在，`api.js` 无对应接口，`dashboard.html` 里连"公告"两个字都没有。这一整套（管理端发布 + 用户端弹窗已读 + 更新后重弹）需要从零开始做
6. **短信发送 KYC 认证链接**：`sendSmsCode(phone, redirectUrl)` 目前是把完整 URL 塞进验证码模板的占位符里发送，**这依赖短信服务商预先审核一个"通知类"模板**（不是标准的验证码模板），实际生产环境需要管理员在短信服务商后台单独报备这个模板，代码里只是尽力发送、失败会被 catch 并返回 `failed: <原因>`

---

## 交接核查时新发现的问题（2026-07-20，均未擅自修改，待用户确认）

1. 🔴 **`server/init.js` 硬编码了超级管理员明文密码**（第 15-17 行，`ADMIN_EMAIL` / `ADMIN_PASSWORD`）。仓库是公开的，这等于把线上超管凭据公开了。建议改成读 `INIT_ADMIN_EMAIL` / `INIT_ADMIN_PASSWORD` 环境变量，未配置时随机生成并打印一次；**并且要先去线上把这个账号的密码改掉**，改代码本身不能撤销已泄露的事实
2. 🟡 **`server/store.js` 是死代码**。它是早期的内存版 Map 存储（用户/OTP/OAuth state），已被 `db.js` 的 SQLite 实现完全取代，全项目无任何文件 `require` 它。留着容易让后续开发者误用（它的字段名是 `passwordHash` 驼峰，和数据库的 `password_hash` 不一致，一旦误用会静默出错）。建议删除
3. 🟡 **`README.md` 第 6 行的版本徽章还是 `version-3.0.0`**，而实际版本是 3.2.0（`package.json` 和 `index.js:130` 都是 3.2.0）。发版时容易漏改，建议后续每次改版本号时把这三处一起改：`package.json` / `server/index.js` 的 `versionLink` / `README.md` 徽章 + 标题
4. 🟡 **`server/init.js` 的 `ENV_KEYS` 预置列表已经落后**。里面没有 Didit KYC、Zeabur Email（`ZEABUR_EMAIL_TOKEN`）、以及所有 `FOOTER_*` 相关的键。新增服务商时除了 `ENV_GROUPS`（`dashboard.html`），也要记得同步这个列表

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
- 版本号规则：语义化三段式，用户明确要求过"第二位版本号加一级"、"改回某个版本号"等操作，说明版本号本身不完全跟随功能量级自动递增，而是用户手动决定的，**改版本号前先确认，不要自作主张递增**
