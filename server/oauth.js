/**
 * OAuth 登录路由
 * 微信公众号 / 企业微信 / 飞书 / 钉钉
 * 抖音 / 快手 / 小红书 / Bilibili
 *
 * 文档参考：
 *   抖音:    https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/oauth2/get-access-token
 *   快手:    https://open.kuaishou.com/platform/openApi?menuId=9
 *   小红书:  https://developers.xiaohongshu.com/docs/oauth2
 *   B站:     https://socialsisteryi.github.io/bilibili-API-collect/docs/login/OAuth2/
 */
const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db, nextUidSeq, users, oauth, state: stateStore, logs } = require('./db');
const { signToken } = require('./auth');

const router = express.Router();

// ──────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────
function genState() {
  return crypto.randomBytes(16).toString('hex');
}

function saveState(state, provider) {
  stateStore.set.run(state, provider, Date.now() + 10 * 60 * 1000);
}

function consumeState(state) {
  const row = stateStore.get.get(state);
  if (!row) return null;
  stateStore.del.run(state);
  if (Date.now() > row.expire_at) return null;
  return row;
}

/** 查找或创建 OAuth 绑定用户，返回用户行 */
function findOrCreate({ provider, openId, unionId = null, name, avatar = null, email = null }) {
  // 1. 按 OAuth 绑定查找
  let user = oauth.findByProvider.get(provider, openId);
  if (user) return user;

  // 2. 若有邮箱，尝试合并到已有邮箱账号
  if (email) {
    const existing = users.findByEmail.get(email);
    if (existing) {
      oauth.bind.run(uuidv4(), existing.id, provider, openId, unionId);
      return existing;
    }
  }

  // 3. 全新用户
  const seq = nextUidSeq();
  const id  = uuidv4();
  users.insert.run({
    id, uid_seq: seq,
    name: name || `用户${seq}`,
    email: email || null,
    phone: null,
    password_hash: null,
    role: 'user',
    admin_level: null,
    user_level: 4,
    status: 'active',
  });
  oauth.bind.run(uuidv4(), id, provider, openId, unionId);
  return users.findById.get(id);
}

/** 登录成功 → 跳转到 dashboard 并携带 token */
function loginSuccess(res, user) {
  if (user.status === 'disabled') {
    return res.redirect('/login.html?error=account_disabled');
  }
  // 写登录日志
  try {
    logs.insert.run({
      id: uuidv4(),
      user_id: user.id, user_name: user.name, uid_seq: String(user.uid_seq),
      method: '第三方 OAuth', app_name: '本系统',
      ip: null, user_agent: null, status: 'success', fail_reason: null,
    });
  } catch (_) {}

  const token = signToken({ uid: user.id, name: user.name, role: user.role, adminLevel: user.admin_level });
  res.redirect(`/login-success.html?token=${token}&name=${encodeURIComponent(user.name || '')}`);
}

/** 统一错误处理 */
function oauthError(res, provider, err) {
  console.error(`[OAuth:${provider}]`, err.response?.data || err.message);
  res.redirect(`/login.html?error=${provider}_failed`);
}

// ══════════════════════════════════════════
// 微信公众号 OAuth2.0
// https://developers.weixin.qq.com/doc/offiaccount/OA_Web_Apps/Wechat_webpage_authorization.html
// ══════════════════════════════════════════
router.get('/wechat', (req, res) => {
  const state = genState();
  saveState(state, 'wechat');
  const p = new URLSearchParams({
    appid: process.env.WECHAT_APP_ID,
    redirect_uri: process.env.WECHAT_REDIRECT_URI,
    response_type: 'code', scope: 'snsapi_userinfo', state,
  });
  res.redirect(`https://open.weixin.qq.com/connect/oauth2/authorize?${p}#wechat_redirect`);
});

router.get('/wechat/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!consumeState(state)) return res.redirect('/login.html?error=invalid_state');
  try {
    const t = (await axios.get('https://api.weixin.qq.com/sns/oauth2/access_token', {
      params: { appid: process.env.WECHAT_APP_ID, secret: process.env.WECHAT_APP_SECRET, code, grant_type: 'authorization_code' },
    })).data;
    const u = (await axios.get('https://api.weixin.qq.com/sns/userinfo', {
      params: { access_token: t.access_token, openid: t.openid, lang: 'zh_CN' },
    })).data;
    loginSuccess(res, findOrCreate({ provider: 'wechat', openId: t.openid, unionId: u.unionid, name: u.nickname, avatar: u.headimgurl }));
  } catch (e) { oauthError(res, 'wechat', e); }
});

// ══════════════════════════════════════════
// 企业微信自建应用
// https://developer.work.weixin.qq.com/document/path/91335
// ══════════════════════════════════════════
router.get('/wecom', (req, res) => {
  const state = genState();
  saveState(state, 'wecom');
  const p = new URLSearchParams({
    appid: process.env.WECOM_CORP_ID, agentid: process.env.WECOM_AGENT_ID,
    redirect_uri: process.env.WECOM_REDIRECT_URI,
    response_type: 'code', scope: 'snsapi_privateinfo', state,
  });
  res.redirect(`https://open.weixin.qq.com/connect/oauth2/authorize?${p}#wechat_redirect`);
});

router.get('/wecom/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!consumeState(state)) return res.redirect('/login.html?error=invalid_state');
  try {
    const { access_token } = (await axios.get('https://qyapi.weixin.qq.com/cgi-bin/gettoken', {
      params: { corpid: process.env.WECOM_CORP_ID, corpsecret: process.env.WECOM_APP_SECRET },
    })).data;
    const ui = (await axios.get('https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo', {
      params: { access_token, code },
    })).data;
    const userId = ui.userid || ui.openid;
    let name = userId, avatar = null;
    if (ui.userid) {
      const d = (await axios.get('https://qyapi.weixin.qq.com/cgi-bin/user/get', {
        params: { access_token, userid: userId },
      })).data;
      name = d.name || userId; avatar = d.avatar;
    }
    loginSuccess(res, findOrCreate({ provider: 'wecom', openId: userId, name, avatar }));
  } catch (e) { oauthError(res, 'wecom', e); }
});

// ══════════════════════════════════════════
// 飞书自建应用
// https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/login/overview
// ══════════════════════════════════════════
router.get('/feishu', (req, res) => {
  const state = genState();
  saveState(state, 'feishu');
  const p = new URLSearchParams({
    client_id: process.env.FEISHU_APP_ID, redirect_uri: process.env.FEISHU_REDIRECT_URI,
    response_type: 'code', scope: 'contact:user.id:readonly', state,
  });
  res.redirect(`https://open.feishu.cn/open-apis/authen/v1/authorize?${p}`);
});

router.get('/feishu/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!consumeState(state)) return res.redirect('/login.html?error=invalid_state');
  try {
    const appToken = (await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET,
    })).data.tenant_access_token;
    const userToken = (await axios.post('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
      grant_type: 'authorization_code', code,
      client_id: process.env.FEISHU_APP_ID, client_secret: process.env.FEISHU_APP_SECRET,
      redirect_uri: process.env.FEISHU_REDIRECT_URI,
    }, { headers: { Authorization: `Bearer ${appToken}` } })).data.data?.access_token;
    const info = (await axios.get('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: { Authorization: `Bearer ${userToken}` },
    })).data.data;
    loginSuccess(res, findOrCreate({
      provider: 'feishu', openId: info.open_id,
      name: info.name || info.en_name, avatar: info.avatar_url,
      email: info.enterprise_email || info.email,
    }));
  } catch (e) { oauthError(res, 'feishu', e); }
});

// ══════════════════════════════════════════
// 钉钉 OAuth 2.0
// https://open.dingtalk.com/document/orgapp/obtain-identity-credentials
// ══════════════════════════════════════════
router.get('/dingtalk', (req, res) => {
  const state = genState();
  saveState(state, 'dingtalk');
  const p = new URLSearchParams({
    client_id: process.env.DINGTALK_CLIENT_ID, redirect_uri: process.env.DINGTALK_REDIRECT_URI,
    response_type: 'code', scope: 'openid', state, prompt: 'consent',
  });
  res.redirect(`https://login.dingtalk.com/oauth2/auth?${p}`);
});

router.get('/dingtalk/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!consumeState(state)) return res.redirect('/login.html?error=invalid_state');
  try {
    const userToken = (await axios.post('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
      clientId: process.env.DINGTALK_CLIENT_ID, clientSecret: process.env.DINGTALK_CLIENT_SECRET,
      code, grantType: 'authorization_code',
    })).data.accessToken;
    const info = (await axios.get('https://api.dingtalk.com/v1.0/contact/users/me', {
      headers: { 'x-acs-dingtalk-access-token': userToken },
    })).data;
    loginSuccess(res, findOrCreate({
      provider: 'dingtalk', openId: info.unionId || info.openId,
      name: info.nick || info.name, avatar: info.avatarUrl, email: info.email,
    }));
  } catch (e) { oauthError(res, 'dingtalk', e); }
});

// ══════════════════════════════════════════
// 抖音开放平台 OAuth 2.0
// https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/oauth2/get-access-token
// 注意：抖音开放平台仅对企业主体开放，需完成企业认证
// ══════════════════════════════════════════
router.get('/douyin', (req, res) => {
  const state = genState();
  saveState(state, 'douyin');
  const p = new URLSearchParams({
    client_key: process.env.DOUYIN_CLIENT_KEY,
    redirect_uri: process.env.DOUYIN_REDIRECT_URI,
    response_type: 'code',
    scope: 'user_info',
    state,
  });
  res.redirect(`https://open.douyin.com/platform/oauth/connect?${p}`);
});

router.get('/douyin/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!consumeState(state)) return res.redirect('/login.html?error=invalid_state');
  try {
    // Step 1: code 换 access_token
    const tokenResp = (await axios.post('https://open.douyin.com/oauth/access_token/', {
      client_key: process.env.DOUYIN_CLIENT_KEY,
      client_secret: process.env.DOUYIN_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    })).data.data;

    // Step 2: 获取用户信息
    const userResp = (await axios.get('https://open.douyin.com/oauth/userinfo/', {
      params: {
        access_token: tokenResp.access_token,
        open_id: tokenResp.open_id,
      },
    })).data.data;

    loginSuccess(res, findOrCreate({
      provider: 'douyin',
      openId: tokenResp.open_id,
      unionId: tokenResp.union_id || null,
      name: userResp.nickname || '抖音用户',
      avatar: userResp.avatar,
    }));
  } catch (e) { oauthError(res, 'douyin', e); }
});

// ══════════════════════════════════════════
// 快手开放平台 OAuth 2.0
// https://open.kuaishou.com/platform/openApi?menuId=9
// 注意：需在快手开放平台完成企业认证并创建应用
// ══════════════════════════════════════════
router.get('/kuaishou', (req, res) => {
  const state = genState();
  saveState(state, 'kuaishou');
  const p = new URLSearchParams({
    app_id: process.env.KUAISHOU_APP_ID,
    redirect_uri: process.env.KUAISHOU_REDIRECT_URI,
    response_type: 'code',
    scope: 'user_info',
    state,
  });
  res.redirect(`https://open.kuaishou.com/oauth2/connect?${p}`);
});

router.get('/kuaishou/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!consumeState(state)) return res.redirect('/login.html?error=invalid_state');
  try {
    // Step 1: code 换 access_token
    const tokenData = (await axios.post('https://open.kuaishou.com/oauth2/access_token', {
      app_id: process.env.KUAISHOU_APP_ID,
      app_secret: process.env.KUAISHOU_APP_SECRET,
      code,
      grant_type: 'authorization_code',
    })).data;

    // Step 2: 获取用户信息
    const userInfo = (await axios.get('https://open.kuaishou.com/openapi/user_info', {
      params: { app_id: process.env.KUAISHOU_APP_ID, access_token: tokenData.access_token },
    })).data.user_info;

    loginSuccess(res, findOrCreate({
      provider: 'kuaishou',
      openId: tokenData.open_id,
      name: userInfo.user_name || '快手用户',
      avatar: userInfo.head_url,
    }));
  } catch (e) { oauthError(res, 'kuaishou', e); }
});

// ══════════════════════════════════════════
// 小红书 OAuth 2.0
// https://developers.xiaohongshu.com/docs/oauth2
// 注意：小红书开放平台目前仅对合作机构开放，需申请接入资质
// ══════════════════════════════════════════
router.get('/xiaohongshu', (req, res) => {
  const state = genState();
  saveState(state, 'xiaohongshu');
  const p = new URLSearchParams({
    appid: process.env.XHS_APP_ID,
    redirect_uri: process.env.XHS_REDIRECT_URI,
    response_type: 'code',
    scope: 'user.info',
    state,
  });
  res.redirect(`https://oauth.xiaohongshu.com/oauth2/authorize?${p}`);
});

router.get('/xiaohongshu/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!consumeState(state)) return res.redirect('/login.html?error=invalid_state');
  try {
    // Step 1: code 换 access_token
    const tokenData = (await axios.post('https://oauth.xiaohongshu.com/oauth2/access_token', null, {
      params: {
        appid: process.env.XHS_APP_ID,
        secret: process.env.XHS_APP_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: process.env.XHS_REDIRECT_URI,
      },
    })).data;

    // Step 2: 获取用户信息
    const userInfo = (await axios.get('https://openapi.xiaohongshu.com/api/sns/v1/user/info', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })).data.data;

    loginSuccess(res, findOrCreate({
      provider: 'xiaohongshu',
      openId: tokenData.user_id || userInfo.open_id,
      name: userInfo.nickname || '小红书用户',
      avatar: userInfo.avatar,
    }));
  } catch (e) { oauthError(res, 'xiaohongshu', e); }
});

// ══════════════════════════════════════════
// Bilibili OAuth 2.0
// https://socialsisteryi.github.io/bilibili-API-collect/docs/login/OAuth2/
// 注意：B站开放平台需申请成为合作开发者，普通账号不可直接接入
// ══════════════════════════════════════════
router.get('/bilibili', (req, res) => {
  const state = genState();
  saveState(state, 'bilibili');
  const p = new URLSearchParams({
    client_id: process.env.BILIBILI_CLIENT_ID,
    redirect_uri: process.env.BILIBILI_REDIRECT_URI,
    response_type: 'code',
    scope: 'user:info',
    state,
  });
  res.redirect(`https://passport.bilibili.com/oauth2/authorize?${p}`);
});

router.get('/bilibili/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!consumeState(state)) return res.redirect('/login.html?error=invalid_state');
  try {
    // Step 1: code 换 access_token（需要 HMAC-SHA256 签名）
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(8).toString('hex');
    const signStr = `client_id=${process.env.BILIBILI_CLIENT_ID}&ts=${ts}&nonce=${nonce}`;
    const sign = crypto.createHmac('sha256', process.env.BILIBILI_CLIENT_SECRET)
      .update(signStr).digest('hex');

    const tokenData = (await axios.post('https://passport.bilibili.com/oauth2/access_token', {
      client_id: process.env.BILIBILI_CLIENT_ID,
      client_secret: process.env.BILIBILI_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.BILIBILI_REDIRECT_URI,
      ts, nonce, sign,
    })).data.data;

    // Step 2: 获取用户信息
    const userInfo = (await axios.get('https://passport.bilibili.com/oauth2/info', {
      params: {
        access_token: tokenData.access_token,
        client_id: process.env.BILIBILI_CLIENT_ID,
        ts, nonce, sign,
      },
    })).data.data;

    loginSuccess(res, findOrCreate({
      provider: 'bilibili',
      openId: String(userInfo.uid || userInfo.mid),
      name: userInfo.uname || 'B站用户',
      avatar: userInfo.face,
    }));
  } catch (e) { oauthError(res, 'bilibili', e); }
});

// ══════════════════════════════════════════
// Google OAuth 2.0
// 文档: https://developers.google.com/identity/protocols/oauth2/web-server
// 控制台: https://console.cloud.google.com → API 和服务 → 凭证 → 创建 OAuth 客户端
// 注意: 回调地址必须在 Google Cloud Console 中注册
// ══════════════════════════════════════════
router.get('/google', (req, res) => {
  const state = genState();
  saveState(state, 'google');
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
});

router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!consumeState(state)) return res.redirect('/login.html?error=invalid_state');
  try {
    // Step 1: code 换 token
    const tokenData = (await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    })).data;

    // Step 2: 从 id_token 解析用户信息（JWT payload，无需额外请求）
    const payload = JSON.parse(Buffer.from(tokenData.id_token.split('.')[1], 'base64').toString());

    loginSuccess(res, findOrCreate({
      provider: 'google',
      openId: payload.sub,
      name: payload.name || payload.email?.split('@')[0] || 'Google 用户',
      avatar: payload.picture,
      email: payload.email,
    }));
  } catch (e) { oauthError(res, 'google', e); }
});

// ══════════════════════════════════════════
// Apple Sign In (Sign in with Apple)
// 文档: https://developer.apple.com/documentation/sign_in_with_apple/sign_in_with_apple_js
// 控制台: https://developer.apple.com → Certificates → Identifiers → Keys
// 注意:
//   1. 需要付费 Apple Developer 账号（$99/年）
//   2. 回调地址必须是 HTTPS，不支持 localhost
//   3. Apple 仅在用户首次授权时返回姓名和邮箱，之后不再返回
//   4. 需创建 Services ID（client_id）和 Key（生成 JWT client_secret）
// ══════════════════════════════════════════
router.get('/apple', (req, res) => {
  const state = genState();
  saveState(state, 'apple');
  const nonce = crypto.randomBytes(16).toString('hex');
  const p = new URLSearchParams({
    client_id: process.env.APPLE_CLIENT_ID,        // Services ID，如 com.yourcompany.sso
    redirect_uri: process.env.APPLE_REDIRECT_URI,
    response_type: 'code id_token',
    response_mode: 'form_post',                    // Apple 强制要求 form_post
    scope: 'name email',
    state,
    nonce,
  });
  res.redirect(`https://appleid.apple.com/auth/authorize?${p}`);
});

// Apple 使用 form_post，所以回调是 POST
router.post('/apple/callback', async (req, res) => {
  const { code, state, id_token, user } = req.body;
  if (!consumeState(state)) return res.redirect('/login.html?error=invalid_state');
  try {
    // 解析 id_token 获取 sub（Apple 用户唯一 ID）
    // 生产环境应验证 id_token 签名（从 https://appleid.apple.com/auth/keys 获取公钥）
    const payload = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64').toString());
    const appleUserId = payload.sub;
    const email = payload.email;

    // user 字段仅首次授权时存在（JSON 字符串）
    let name = 'Apple 用户';
    if (user) {
      try {
        const parsed = typeof user === 'string' ? JSON.parse(user) : user;
        const fn = parsed?.name?.firstName || '';
        const ln = parsed?.name?.lastName || '';
        name = (fn + ' ' + ln).trim() || email?.split('@')[0] || name;
      } catch (_) {}
    }

    loginSuccess(res, findOrCreate({
      provider: 'apple',
      openId: appleUserId,
      name,
      email,
    }));
  } catch (e) { oauthError(res, 'apple', e); }
});

module.exports = router;
