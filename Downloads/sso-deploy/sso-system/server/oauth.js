/**
 * OAuth 登录路由
 * 微信公众号 / 企业微信 / 飞书 / 钉钉
 */
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const store = require('./store');
const { signToken } = require('./auth');

const router = express.Router();

// 辅助: 生成随机 state
function randomState() {
  return crypto.randomBytes(16).toString('hex');
}

// 辅助: 登录成功跳转（带 token）
function loginSuccess(res, user) {
  const token = signToken({ uid: user.id, name: user.name, email: user.email });
  // 跳回前端并传递 token（也可以通过 cookie）
  res.redirect(`/login-success.html?token=${token}&name=${encodeURIComponent(user.name || '')}`);
}

// 辅助: 查找或创建 OAuth 用户
function findOrCreateOAuthUser({ provider, openId, name, avatar, email }) {
  let user = store.findUserByOAuth(provider, openId);
  if (!user) {
    user = store.createUser({
      id: uuidv4(),
      name,
      avatar,
      email: email || null,
      oauth: { [provider]: openId },
    });
  }
  return user;
}

// ============================================================
// 微信公众号 OAuth2.0 网页授权
// 文档: https://developers.weixin.qq.com/doc/offiaccount/OA_Web_Apps/Wechat_webpage_authorization.html
// ============================================================
router.get('/wechat', (req, res) => {
  const state = randomState();
  store.setOAuthState(state, { provider: 'wechat' });

  const params = new URLSearchParams({
    appid: process.env.WECHAT_APP_ID,
    redirect_uri: process.env.WECHAT_REDIRECT_URI,
    response_type: 'code',
    scope: 'snsapi_userinfo',
    state,
  });
  res.redirect(`https://open.weixin.qq.com/connect/oauth2/authorize?${params}#wechat_redirect`);
});

router.get('/wechat/callback', async (req, res) => {
  const { code, state } = req.query;
  const stateData = store.getOAuthState(state);
  if (!stateData) return res.redirect('/login.html?error=invalid_state');

  try {
    // Step 1: code 换 access_token
    const tokenResp = await axios.get('https://api.weixin.qq.com/sns/oauth2/access_token', {
      params: {
        appid: process.env.WECHAT_APP_ID,
        secret: process.env.WECHAT_APP_SECRET,
        code,
        grant_type: 'authorization_code',
      },
    });
    const { access_token, openid } = tokenResp.data;

    // Step 2: 拉取用户信息
    const userResp = await axios.get('https://api.weixin.qq.com/sns/userinfo', {
      params: { access_token, openid, lang: 'zh_CN' },
    });
    const { nickname, headimgurl } = userResp.data;

    const user = findOrCreateOAuthUser({ provider: 'wechat', openId: openid, name: nickname, avatar: headimgurl });
    loginSuccess(res, user);
  } catch (err) {
    console.error('[WeChat OAuth]', err.message);
    res.redirect('/login.html?error=wechat_failed');
  }
});

// ============================================================
// 企业微信自建应用 OAuth
// 文档: https://developer.work.weixin.qq.com/document/path/91335
// ============================================================
router.get('/wecom', (req, res) => {
  const state = randomState();
  store.setOAuthState(state, { provider: 'wecom' });

  const params = new URLSearchParams({
    appid: process.env.WECOM_CORP_ID,
    agentid: process.env.WECOM_AGENT_ID,
    redirect_uri: process.env.WECOM_REDIRECT_URI,
    response_type: 'code',
    scope: 'snsapi_privateinfo',
    state,
  });
  res.redirect(`https://open.weixin.qq.com/connect/oauth2/authorize?${params}#wechat_redirect`);
});

router.get('/wecom/callback', async (req, res) => {
  const { code, state } = req.query;
  const stateData = store.getOAuthState(state);
  if (!stateData) return res.redirect('/login.html?error=invalid_state');

  try {
    // Step 1: 获取 access_token
    const tokenResp = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/gettoken', {
      params: { corpid: process.env.WECOM_CORP_ID, corpsecret: process.env.WECOM_APP_SECRET },
    });
    const { access_token } = tokenResp.data;

    // Step 2: code 换 user_id
    const userIdResp = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo', {
      params: { access_token, code },
    });
    const userId = userIdResp.data.userid || userIdResp.data.openid;

    // Step 3: 获取用户详情
    let name = userId, avatar = null;
    if (userIdResp.data.userid) {
      const detailResp = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/user/get', {
        params: { access_token, userid: userId },
      });
      name = detailResp.data.name || userId;
      avatar = detailResp.data.avatar;
    }

    const user = findOrCreateOAuthUser({ provider: 'wecom', openId: userId, name, avatar });
    loginSuccess(res, user);
  } catch (err) {
    console.error('[WeCom OAuth]', err.message);
    res.redirect('/login.html?error=wecom_failed');
  }
});

// ============================================================
// 飞书自建应用 OAuth
// 文档: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/login/overview
// ============================================================
router.get('/feishu', (req, res) => {
  const state = randomState();
  store.setOAuthState(state, { provider: 'feishu' });

  const params = new URLSearchParams({
    client_id: process.env.FEISHU_APP_ID,
    redirect_uri: process.env.FEISHU_REDIRECT_URI,
    response_type: 'code',
    scope: 'contact:user.id:readonly',
    state,
  });
  res.redirect(`https://open.feishu.cn/open-apis/authen/v1/authorize?${params}`);
});

router.get('/feishu/callback', async (req, res) => {
  const { code, state } = req.query;
  const stateData = store.getOAuthState(state);
  if (!stateData) return res.redirect('/login.html?error=invalid_state');

  try {
    // Step 1: 获取 app_access_token
    const appTokenResp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
    });
    const appToken = appTokenResp.data.tenant_access_token;

    // Step 2: code 换 user_access_token
    const userTokenResp = await axios.post(
      'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
      {
        grant_type: 'authorization_code',
        code,
        client_id: process.env.FEISHU_APP_ID,
        client_secret: process.env.FEISHU_APP_SECRET,
        redirect_uri: process.env.FEISHU_REDIRECT_URI,
      },
      { headers: { Authorization: `Bearer ${appToken}` } }
    );
    const userToken = userTokenResp.data.data?.access_token;

    // Step 3: 获取用户信息
    const userInfoResp = await axios.get('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const info = userInfoResp.data.data;
    const user = findOrCreateOAuthUser({
      provider: 'feishu',
      openId: info.open_id,
      name: info.name || info.en_name,
      avatar: info.avatar_url,
      email: info.enterprise_email || info.email,
    });
    loginSuccess(res, user);
  } catch (err) {
    console.error('[Feishu OAuth]', err.message);
    res.redirect('/login.html?error=feishu_failed');
  }
});

// ============================================================
// 钉钉应用 OAuth 2.0
// 文档: https://open.dingtalk.com/document/orgapp/obtain-identity-credentials
// ============================================================
router.get('/dingtalk', (req, res) => {
  const state = randomState();
  store.setOAuthState(state, { provider: 'dingtalk' });

  const params = new URLSearchParams({
    client_id: process.env.DINGTALK_CLIENT_ID,
    redirect_uri: process.env.DINGTALK_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid',
    state,
    prompt: 'consent',
  });
  res.redirect(`https://login.dingtalk.com/oauth2/auth?${params}`);
});

router.get('/dingtalk/callback', async (req, res) => {
  const { code, state } = req.query;
  const stateData = store.getOAuthState(state);
  if (!stateData) return res.redirect('/login.html?error=invalid_state');

  try {
    // Step 1: code 换 access_token
    const tokenResp = await axios.post('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
      clientId: process.env.DINGTALK_CLIENT_ID,
      clientSecret: process.env.DINGTALK_CLIENT_SECRET,
      code,
      grantType: 'authorization_code',
    });
    const userToken = tokenResp.data.accessToken;

    // Step 2: 获取用户信息
    const userInfoResp = await axios.get('https://api.dingtalk.com/v1.0/contact/users/me', {
      headers: { 'x-acs-dingtalk-access-token': userToken },
    });
    const info = userInfoResp.data;

    const user = findOrCreateOAuthUser({
      provider: 'dingtalk',
      openId: info.unionId || info.openId,
      name: info.nick || info.name,
      avatar: info.avatarUrl,
      email: info.email,
    });
    loginSuccess(res, user);
  } catch (err) {
    console.error('[DingTalk OAuth]', err.message);
    res.redirect('/login.html?error=dingtalk_failed');
  }
});

module.exports = router;
