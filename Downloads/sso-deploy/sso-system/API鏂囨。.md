# 统一登录系统 SSO — API 对接文档

> 版本：v2.0　　最后更新：2025-06

---

## 目录

1. [基础说明](#一基础说明)
2. [鉴权机制](#二鉴权机制)
3. [通用登录接口](#三通用登录接口)
4. [用户接口](#四用户接口)
5. [应用市场接口](#五应用市场接口)
6. [开放 API（第三方系统对接）](#六开放-api第三方系统对接)
7. [管理端接口](#七管理端接口)
8. [错误码说明](#八错误码说明)
9. [对接流程示例](#九对接流程示例)

---

## 一、基础说明

### 服务地址

| 环境 | 地址 |
|------|------|
| 开发环境 | `http://localhost:3000` |
| 生产环境 | 部署后填写的 `BASE_URL` |

所有 API 路径均以 `/api` 为前缀，开放 API 以 `/api/v1` 为前缀。

### 请求规范

- 请求方式：`HTTP/1.1`
- 数据格式：`Content-Type: application/json`
- 字符编码：`UTF-8`
- 时间格式：ISO 8601，如 `2025-06-23T09:14:00`

### 通用响应结构

**成功**

```json
{
  "success": true,
  "data": { ... }
}
```

**失败**

```json
{
  "error": "错误描述"
}
```

---

## 二、鉴权机制

系统有两套独立的鉴权体系，分别用于不同场景。

### 2.1 用户 JWT Token（用户端 / 管理端）

用户登录后获得 JWT Token，携带在请求头中访问用户相关接口。

```
Authorization: Bearer <jwt_token>
```

**Token 载荷字段**

| 字段 | 类型 | 说明 |
|------|------|------|
| `uid` | string | 用户 UUID |
| `name` | string | 用户名称 |
| `role` | string | 角色：`user` / `admin` |
| `adminLevel` | number | 管理员等级 1-3，普通用户为 null |
| `iat` | number | 签发时间（Unix 时间戳） |
| `exp` | number | 过期时间（Unix 时间戳） |

**Token 有效期**：默认 7 天，可通过 `JWT_EXPIRES_IN` 环境变量配置。

### 2.2 API Key（第三方系统对接）

第三方系统通过管理员在控制台创建的 API Key 调用开放接口，格式为 `sk-live-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`。

```
Authorization: Bearer sk-live-xxxxxxxxxxxxxxxx...
```

> API Key 与用户 JWT Token **不能互换使用**。开放接口（`/api/v1/*`）使用 API Key，其余接口使用 JWT Token。

**权限范围（Scope）**

创建 API Key 时需指定权限范围，每个接口要求不同的 scope：

| Scope | 说明 |
|-------|------|
| `auth:verify` | 验证用户 Token 有效性 |
| `users:read` | 读取用户列表与详情 |
| `users:write` | 停用 / 启用用户账号 |
| `users:kyc` | 删除用户实名认证信息 |
| `apps:read` | 读取应用列表 |
| `sms:send` | 代发短信 |
| `logs:read` | 读取全量登录日志 |

---

## 三、通用登录接口

这些接口无需鉴权，用于用户登录注册。

---

### 3.1 发送短信验证码

```
POST /api/sms/send
```

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `phone` | string | ✅ | 手机号，支持中国大陆 1 开头 11 位号码 |

**请求示例**

```json
{
  "phone": "13800138000"
}
```

**响应示例**

```json
{
  "success": true,
  "expires": 300
}
```

| 字段 | 说明 |
|------|------|
| `expires` | 验证码有效期（秒），默认 300 秒 |

> 开发模式（`NODE_ENV !== production`）下验证码只打印到控制台，不实际发送。

---

### 3.2 验证短信验证码并登录

```
POST /api/sms/verify
```

首次使用该手机号将自动注册账号。

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `phone` | string | ✅ | 手机号 |
| `code` | string | ✅ | 6 位短信验证码 |

**请求示例**

```json
{
  "phone": "13800138000",
  "code": "123456"
}
```

**响应示例**

```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "uid_seq": 42,
    "name": "用户8000",
    "phone": "13800138000",
    "email": null,
    "role": "user",
    "user_level": 4,
    "status": "active",
    "points": 0,
    "kyc_verified": 0,
    "created_at": "2025-06-23T09:14:00"
  }
}
```

---

### 3.3 发送邮箱验证码

```
POST /api/email/send-code
```

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `email` | string | ✅ | 邮箱地址 |

**请求示例**

```json
{
  "email": "user@example.com"
}
```

**响应示例**

```json
{
  "success": true,
  "expires": 600
}
```

---

### 3.4 验证邮箱验证码并登录

```
POST /api/email/verify-code
```

首次使用该邮箱将自动注册账号。

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `email` | string | ✅ | 邮箱地址 |
| `code` | string | ✅ | 6 位邮箱验证码 |

**响应结构**：同 [3.2](#32-验证短信验证码并登录)

---

### 3.5 邮箱注册

```
POST /api/email/register
```

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `email` | string | ✅ | 邮箱地址 |
| `password` | string | ✅ | 密码，至少 6 位 |
| `name` | string | ❌ | 显示名称，默认取邮箱前缀 |

**请求示例**

```json
{
  "email": "user@example.com",
  "password": "MyPass123",
  "name": "张三"
}
```

**响应结构**：同 [3.2](#32-验证短信验证码并登录)

---

### 3.6 邮箱密码登录

```
POST /api/email/login
```

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `email` | string | ✅ | 邮箱地址 |
| `password` | string | ✅ | 密码 |

**响应结构**：同 [3.2](#32-验证短信验证码并登录)

---

### 3.7 验证用户 Token（SSO 回调验证）

```
POST /api/auth/verify
```

**鉴权**：`Authorization: Bearer <用户JWT>`

用于第三方应用在用户跳转回来后，验证用户 JWT 的有效性并获取用户信息。

**无请求体**

**响应示例**

```json
{
  "valid": true,
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "uid_seq": 42,
    "name": "张三",
    "email": "user@example.com",
    "role": "user",
    "user_level": 3,
    "status": "active",
    "kyc_verified": 1,
    "kyc_name": "张 * 三",
    "kyc_id_tail": "****1234"
  }
}
```

Token 无效时返回：

```json
{
  "valid": false
}
```

---

## 四、用户接口

以下接口均需携带用户 JWT Token。

---

### 4.1 获取当前用户信息

```
GET /api/user/me
```

**鉴权**：`Authorization: Bearer <用户JWT>`

**响应示例**

```json
{
  "success": true,
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "uid_seq": 42,
    "name": "张三",
    "email": "user@example.com",
    "phone": "138****8000",
    "role": "user",
    "user_level": 3,
    "admin_level": null,
    "status": "active",
    "points": 380,
    "checkin_streak": 5,
    "last_checkin": "2025-06-23",
    "kyc_verified": 1,
    "kyc_name": "张 * 三",
    "kyc_id_tail": "****1234",
    "kyc_provider": "aliyun",
    "kyc_verified_at": "2022-03-16T10:22:00",
    "created_at": "2022-03-15T08:00:00",
    "oauthBinds": [
      {
        "provider": "wechat",
        "open_id": "o6_bmjrPTlm6_2sgVt7hMZOPfL2M",
        "bound_at": "2022-03-16T11:00:00"
      }
    ]
  }
}
```

---

### 4.2 修改用户资料

```
POST /api/user/profile
```

**鉴权**：`Authorization: Bearer <用户JWT>`

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ❌ | 昵称 |
| `phone` | string | ❌ | 手机号（需未被其他账号占用） |

**响应示例**

```json
{
  "success": true
}
```

---

### 4.3 每日签到

```
POST /api/user/checkin
```

**鉴权**：`Authorization: Bearer <用户JWT>`

每日只能签到一次，每次获得 10 积分。

**响应示例**

```json
{
  "success": true,
  "points": 10,
  "streak": 6,
  "total": 390
}
```

| 字段 | 说明 |
|------|------|
| `points` | 本次获得积分 |
| `streak` | 当前连续签到天数 |
| `total` | 累计总积分 |

已签到时返回 `400`：

```json
{
  "error": "今日已签到"
}
```

---

### 4.4 删除实名认证信息

```
DELETE /api/user/kyc
```

**鉴权**：`Authorization: Bearer <用户JWT>`

删除后可重新发起认证。

**响应示例**

```json
{
  "success": true
}
```

---

### 4.5 解绑三方账号

```
DELETE /api/user/oauth/:provider
```

**鉴权**：`Authorization: Bearer <用户JWT>`

**路径参数**

| 参数 | 说明 |
|------|------|
| `provider` | 平台名：`wechat` / `wecom` / `feishu` / `dingtalk` |

**响应示例**

```json
{
  "success": true
}
```

---

### 4.6 获取登录历史

```
GET /api/user/login-logs
```

**鉴权**：`Authorization: Bearer <用户JWT>`

返回最近 20 条登录记录。

**响应示例**

```json
{
  "success": true,
  "logs": [
    {
      "id": "log_uuid",
      "method": "邮箱密码",
      "app_name": "本系统",
      "ip": "121.44.xx.xx",
      "user_agent": "Chrome/125.0 macOS",
      "status": "success",
      "fail_reason": null,
      "created_at": "2025-06-23T09:14:00"
    }
  ]
}
```

`status` 取值：`success`（成功）/ `failed`（失败）/ `disabled`（账号停用）

---

## 五、应用市场接口

---

### 5.1 获取应用市场列表

```
GET /api/apps/market
```

**鉴权**：`Authorization: Bearer <用户JWT>`

仅返回状态为 `enabled` 且用户端可见的应用。

**响应示例**

```json
{
  "success": true,
  "apps": [
    {
      "id": "app_uuid",
      "name": "企业 OA 系统",
      "icon": "📋",
      "icon_bg": "#E8F4FF",
      "description": "内部工单与审批流程管理",
      "client_id": "app_a1b2c3d4e5f6",
      "callback_url": "https://oa.example.com/sso/callback",
      "auth_users": 342,
      "status": "enabled",
      "userAuthed": true
    }
  ]
}
```

---

### 5.2 授权应用

```
POST /api/apps/:id/auth
```

**鉴权**：`Authorization: Bearer <用户JWT>`

**路径参数**

| 参数 | 说明 |
|------|------|
| `id` | 应用 UUID |

**响应示例**

```json
{
  "success": true
}
```

---

### 5.3 撤销应用授权

```
DELETE /api/apps/:id/auth
```

**鉴权**：`Authorization: Bearer <用户JWT>`

**响应示例**

```json
{
  "success": true
}
```

---

### 5.4 获取已授权应用列表

```
GET /api/apps/authed
```

**鉴权**：`Authorization: Bearer <用户JWT>`

**响应示例**

```json
{
  "success": true,
  "apps": [
    {
      "id": "app_uuid",
      "name": "企业 OA 系统",
      "client_id": "app_a1b2c3d4e5f6",
      "status": "enabled"
    }
  ]
}
```

---

## 六、开放 API（第三方系统对接）

> 这组接口专为系统间对接设计，使用 **API Key** 鉴权，与用户 JWT 完全独立。
>
> **获取方式**：管理员登录控制台 → 管理端 → API 调用 → 新建密钥，并分配所需 scope。

所有开放接口以 `/api/v1` 为前缀。

---

### 6.1 验证用户 Token ★ 最常用

```
GET /api/v1/auth/verify
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `auth:verify`）

**请求头**

| 请求头 | 必填 | 说明 |
|--------|------|------|
| `x-user-token` | ✅ | 需要验证的用户 JWT Token |

**请求示例（cURL）**

```bash
curl -X GET "https://sso.example.com/api/v1/auth/verify" \
  -H "Authorization: Bearer sk-live-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "x-user-token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**响应示例（有效）**

```json
{
  "valid": true,
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "uid_seq": 42,
    "name": "张三",
    "email": "user@example.com",
    "phone": "138****8000",
    "role": "user",
    "user_level": 3,
    "status": "active",
    "kyc_verified": 1,
    "kyc_name": "张 * 三",
    "points": 380,
    "created_at": "2022-03-15T08:00:00"
  }
}
```

**响应示例（无效）**

```json
{
  "valid": false
}
```

---

### 6.2 获取用户列表

```
GET /api/v1/users
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `users:read`）

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `page` | number | ❌ | 页码，默认 `1` |
| `limit` | number | ❌ | 每页条数，默认 `20`，最大 `100` |
| `status` | string | ❌ | 筛选状态：`active` / `disabled` |

**请求示例**

```bash
curl -X GET "https://sso.example.com/api/v1/users?page=1&limit=20&status=active" \
  -H "Authorization: Bearer sk-live-xxxxxxxxxxxxxxxx..."
```

**响应示例**

```json
{
  "total": 1482,
  "page": 1,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "uid_seq": 42,
      "name": "张三",
      "email": "user@example.com",
      "phone": "138****8000",
      "role": "user",
      "user_level": 3,
      "status": "active",
      "kyc_verified": 1,
      "points": 380,
      "created_at": "2022-03-15T08:00:00"
    }
  ]
}
```

---

### 6.3 获取单个用户详情

```
GET /api/v1/users/:uid
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `users:read`）

**路径参数**

| 参数 | 说明 |
|------|------|
| `uid` | 用户 UUID 或用户编号（`uid_seq`，如 `42`） |

**请求示例**

```bash
curl -X GET "https://sso.example.com/api/v1/users/42" \
  -H "Authorization: Bearer sk-live-xxxxxxxxxxxxxxxx..."
```

**响应示例**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "uid_seq": 42,
  "name": "张三",
  "email": "user@example.com",
  "phone": "138****8000",
  "role": "user",
  "user_level": 3,
  "status": "active",
  "kyc_verified": 1,
  "kyc_name": "张 * 三",
  "kyc_id_tail": "****1234",
  "kyc_provider": "aliyun",
  "points": 380,
  "checkin_streak": 5,
  "created_at": "2022-03-15T08:00:00",
  "updated_at": "2025-06-23T09:00:00"
}
```

---

### 6.4 停用用户账号

```
POST /api/v1/users/:uid/disable
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `users:write`）

停用后该用户无法登录，登录接口返回 `403`。

**响应示例**

```json
{
  "success": true
}
```

---

### 6.5 启用用户账号

```
POST /api/v1/users/:uid/enable
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `users:write`）

**响应示例**

```json
{
  "success": true
}
```

---

### 6.6 删除用户实名信息

```
DELETE /api/v1/users/:uid/realname
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `users:kyc`）

删除后用户的 `kyc_verified` 置为 `0`，用户可重新发起认证。

**响应示例**

```json
{
  "success": true
}
```

---

### 6.7 获取应用列表

```
GET /api/v1/apps
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `apps:read`）

**响应示例**

```json
{
  "total": 4,
  "data": [
    {
      "id": "app_uuid",
      "name": "企业 OA 系统",
      "client_id": "app_a1b2c3d4e5f6",
      "callback_url": "https://oa.example.com/sso/callback",
      "status": "enabled",
      "visible": 1,
      "auth_users": 342,
      "created_at": "2025-01-01T00:00:00"
    }
  ]
}
```

---

### 6.8 代发短信

```
POST /api/v1/sms/send
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `sms:send`）

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `phone` | string | ✅ | 手机号 |

**请求示例**

```json
{
  "phone": "13800138000"
}
```

**响应示例**

```json
{
  "success": true,
  "msgId": "sms_1719133200000"
}
```

---

### 6.9 获取全量登录日志

```
GET /api/v1/logs
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `logs:read`）

返回最新 200 条。

**响应示例**

```json
{
  "total": 200,
  "data": [
    {
      "id": "log_uuid",
      "user_id": "user_uuid",
      "user_name": "张三",
      "uid_seq": "00042",
      "method": "邮箱密码",
      "app_name": "企业 OA 系统",
      "ip": "121.44.xx.xx",
      "user_agent": "Chrome/125.0 macOS",
      "status": "success",
      "fail_reason": null,
      "created_at": "2025-06-23T09:14:00"
    }
  ]
}
```

---

## 七、管理端接口

> 以下接口需要管理员 JWT Token，且部分接口对等级有要求。
>
> - **Lv.1 超级管理员**：可操作全部接口
> - **Lv.2 运营管理员**：可操作用户、应用管理，不可操作 API Key、环境变量
> - **Lv.3 只读管理员**：仅可查询，不可修改

---

### 7.1 获取统计数据

```
GET /api/admin/stats
```

**所需等级**：Lv.3 及以上

**响应示例**

```json
{
  "success": true,
  "stats": {
    "total": 1482,
    "verified": 896,
    "todayActive": 218,
    "newThisMonth": 43,
    "daily7": [
      { "d": "2025-06-17", "n": 8 },
      { "d": "2025-06-18", "n": 12 }
    ]
  }
}
```

---

### 7.2 获取用户列表

```
GET /api/admin/users
```

**所需等级**：Lv.3 及以上

**Query 参数**

| 参数 | 说明 |
|------|------|
| `q` | 关键字搜索（姓名 / 邮箱 / 手机号） |
| `status` | `active` / `disabled` |

---

### 7.3 获取用户详情

```
GET /api/admin/users/:id
```

**所需等级**：Lv.3 及以上

返回字段包括基本信息、三方绑定、已授权应用、最近登录记录。

---

### 7.4 修改用户信息

```
PATCH /api/admin/users/:id
```

**所需等级**：Lv.2 及以上

**请求体（所有字段均可选）**

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | string | 姓名 |
| `email` | string | 邮箱 |
| `phone` | string | 手机号 |
| `status` | string | `active` / `disabled` |
| `user_level` | number | 用户等级 1-5 |
| `admin_level` | number | 管理员等级 1-3，或 `null` |

---

### 7.5 停用 / 启用用户

```
POST /api/admin/users/:id/disable
POST /api/admin/users/:id/enable
```

**所需等级**：Lv.2 及以上

---

### 7.6 重置用户密码

```
POST /api/admin/users/:id/reset-password
```

**所需等级**：Lv.2 及以上

**请求体**

```json
{
  "password": "NewPassword123"
}
```

---

### 7.7 删除用户实名信息（管理端）

```
DELETE /api/admin/users/:id/kyc
```

**所需等级**：Lv.2 及以上

---

### 7.8 获取用户登录日志

```
GET /api/admin/users/:id/logs
```

**所需等级**：Lv.3 及以上，返回最近 50 条。

---

### 7.9 应用管理

```
GET    /api/admin/apps           # 获取所有应用
POST   /api/admin/apps           # 新增应用
PATCH  /api/admin/apps/:id       # 修改应用
POST   /api/admin/apps/:id/approve  # 审核通过并上架
```

**所需等级**：查询 Lv.3，修改 Lv.2

新增应用请求体：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 应用名称 |
| `callback_url` | string | ✅ | OAuth 回调地址 |
| `icon` | string | ❌ | Emoji 图标，默认 `📦` |
| `description` | string | ❌ | 应用描述 |
| `visible` | boolean | ❌ | 是否在用户端市场展示，默认 `false` |

---

### 7.10 获取全量登录日志（管理端）

```
GET /api/admin/logs
```

**所需等级**：Lv.3 及以上，返回最新 200 条。

---

### 7.11 API Key 管理

```
GET    /api/admin/api-keys       # 获取所有 API Key
POST   /api/admin/api-keys       # 创建新 API Key
DELETE /api/admin/api-keys/:id   # 撤销 API Key
```

**所需等级**：Lv.1（超级管理员）

创建请求体：

```json
{
  "name": "主系统对接",
  "scopes": ["auth:verify", "users:read"]
}
```

创建响应（**token 仅返回一次，请立即保存**）：

```json
{
  "success": true,
  "token": "sk-live-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

---

### 7.12 环境变量管理

```
GET  /api/admin/env         # 获取所有环境变量
POST /api/admin/env         # 批量保存环境变量
```

**所需等级**：Lv.1（超级管理员）

保存请求体：

```json
{
  "vars": {
    "WECHAT_APP_ID": "wx1234567890abcdef",
    "WECHAT_APP_SECRET": "your_secret",
    "SMS_PROVIDER": "volcengine"
  }
}
```

---

## 八、错误码说明

| HTTP 状态码 | 说明 |
|-------------|------|
| `200` | 请求成功 |
| `400` | 请求参数错误，详见 `error` 字段 |
| `401` | 未登录或 Token 无效 / 过期 |
| `403` | 权限不足（账号停用、等级不够、scope 缺失） |
| `404` | 资源不存在 |
| `429` | 请求频率超限（生产环境限流） |
| `500` | 服务器内部错误 |

**常见错误信息**

| 错误信息 | 原因 |
|----------|------|
| `手机号格式不正确` | 非中国大陆 1 开头 11 位号码 |
| `验证码不存在或已过期` | 未发送验证码或已超时 |
| `验证码错误` | 输入有误 |
| `错误次数过多，请重新获取` | 同一验证码错误 5 次 |
| `该邮箱已注册` | 邮箱已被占用 |
| `邮箱或密码不正确` | 账号不存在或密码错误 |
| `账号已停用，请联系管理员` | 账号被管理员停用 |
| `未登录或 Token 缺失` | 请求头缺少 Authorization |
| `Token 无效` | Token 格式错误、签名不符或已过期 |
| `需要管理员权限` | 普通用户访问管理接口 |
| `API Key 无效或已撤销` | Key 不存在或已被撤销 |
| `权限不足，需要 scope: xxx` | Key 未分配所需权限 |

---

## 九、对接流程示例

### 场景一：第三方系统接入 SSO 单点登录

用户在第三方系统点击"SSO 登录"，跳转到本系统登录页，登录后携带 Token 跳回。

```
1. 第三方系统跳转 →  https://sso.example.com/login.html?redirect=https://yourapp.com/callback

2. 用户在 SSO 登录页完成登录，获得 JWT Token

3. 跳转回调（前端传递 Token）
   https://yourapp.com/callback?token=eyJhbGci...

4. 第三方系统服务端验证 Token
   GET /api/v1/auth/verify
   Authorization: Bearer sk-live-xxxxxxxx...（API Key）
   x-user-token: eyJhbGci...（用户 Token）

5. 返回用户信息，第三方系统建立自己的会话
```

**Node.js 验证示例**

```javascript
const res = await fetch('https://sso.example.com/api/v1/auth/verify', {
  method: 'GET',
  headers: {
    'Authorization': 'Bearer sk-live-xxxxxxxxxxxxxxxx...',
    'x-user-token': req.query.token,
  }
});

const { valid, user } = await res.json();

if (valid && user.status === 'active') {
  // 建立会话，user.uid_seq 作为用户唯一标识
  req.session.userId = user.uid_seq;
  req.session.userName = user.name;
} else {
  // Token 无效或用户已停用
  res.redirect('/login');
}
```

---

### 场景二：第三方系统同步用户状态

```javascript
// 获取 SSO 用户信息
const userRes = await fetch(`https://sso.example.com/api/v1/users/${uid}`, {
  headers: { 'Authorization': 'Bearer sk-live-xxxxxxxx...' }
});
const user = await userRes.json();

// 根据 kyc_verified 判断是否实名
if (!user.kyc_verified) {
  // 引导用户去 SSO 完成实名认证
}

// 根据 user_level 判断用户权限等级
if (user.user_level <= 2) {
  // 高等级用户，开放高级功能
}
```

---

### 场景三：在第三方系统中停用账号

当用户在第三方系统触发违规时，同步停用 SSO 账号：

```javascript
await fetch(`https://sso.example.com/api/v1/users/${uid}/disable`, {
  method: 'POST',
  headers: { 'Authorization': 'Bearer sk-live-xxxxxxxx...' }
});
// 停用后该用户在所有接入本 SSO 的系统均无法登录
```

---

*文档结束。如有问题请联系系统管理员，或查阅源码 `server/api.js`。*
