/**
 * KYC 实名认证服务 - 支持多服务商轮询
 * 服务商：Didit / Stripe Identity / 阿里云实人认证 / 火山引擎人脸认证
 *
 * 模式说明：
 *   - Didit / Stripe：创建认证会话 → 返回跳转 URL → 用户完成后 Webhook 通知结果
 *   - 阿里云 / 火山引擎：传统服务端提交（适合有证件照片的场景）
 */
const axios  = require('axios');
const crypto = require('crypto');
const { pollExecute, getStrategy, recordCall } = require('./poller');

// ══════════════════════════════════════════════════════════
// Didit KYC
// 文档：https://docs.didit.me/integration/integration-prompt
// ══════════════════════════════════════════════════════════
async function createDiditSession(userId, callbackUrl) {
  const apiKey     = process.env.DIDIT_API_KEY;
  const workflowId = process.env.DIDIT_WORKFLOW_ID;
  if (!apiKey || !workflowId) throw new Error('Didit 未配置 DIDIT_API_KEY 或 DIDIT_WORKFLOW_ID');

  const resp = await axios.post('https://verification.didit.me/v3/session/', {
    workflow_id:  workflowId,
    vendor_data:  String(userId),
    callback:     callbackUrl,
  }, {
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
  });

  const { session_id, url } = resp.data;
  return { provider: 'didit', session_id, redirect_url: url };
}

/**
 * 验证 Didit Webhook（HMAC-SHA256）
 * 在 Didit 控制台配置 Webhook Secret 后调用此函数验证签名
 */
function verifyDiditWebhook(rawBody, signature, secret) {
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

// ══════════════════════════════════════════════════════════
// Stripe Identity
// 文档：https://docs.stripe.com/identity/verification-sessions
// ══════════════════════════════════════════════════════════
async function createStripeSession(userId, callbackUrl) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('Stripe Identity 未配置 STRIPE_SECRET_KEY');

  // 使用 FormData 格式（Stripe API 用 URL-encoded）
  const params = new URLSearchParams({
    type:          'document',
    'metadata[user_id]': String(userId),
    'options[document][require_matching_selfie]': 'true',
    return_url:    callbackUrl,
  });

  const resp = await axios.post(
    'https://api.stripe.com/v1/identity/verification_sessions',
    params.toString(),
    {
      headers: {
        Authorization:  `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  const { id: session_id, url } = resp.data;
  return { provider: 'stripe', session_id, redirect_url: url };
}

/**
 * 验证 Stripe Webhook 签名
 */
function verifyStripeWebhook(rawBody, signature, secret) {
  try {
    // Stripe signature format: t=timestamp,v1=hash
    const elements = signature.split(',');
    const timestamp = elements.find(e => e.startsWith('t=')).slice(2);
    const v1 = elements.find(e => e.startsWith('v1=')).slice(3);
    const payload = `${timestamp}.${rawBody}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  } catch (_) {
    return false;
  }
}

// ══════════════════════════════════════════════════════════
// 阿里云实人认证
// ══════════════════════════════════════════════════════════
async function verifyViaAliyunKYC(name, idNumber) {
  // 优先用 KYC 专用 AK（管理端「KYC · 阿里云」面板填的就是这两个），
  // 没配才回退到通用 AK。v3.3.3 之前只读通用 AK，导致面板里填的 KYC 专用密钥
  // 从来没生效过，KYC 实际是在借用短信的凭据。
  const accessKeyId = process.env.ALIYUN_KYC_ACCESS_KEY_ID     || process.env.ALIYUN_ACCESS_KEY_ID;
  const secretKey   = process.env.ALIYUN_KYC_ACCESS_KEY_SECRET || process.env.ALIYUN_ACCESS_KEY_SECRET;

  const params = {
    AccessKeyId:       accessKeyId,
    Action:            'VerifyMaterial',
    Format:            'JSON',
    IdCardNumber:      idNumber,
    IdCardName:        name,
    ProductCode:       process.env.ALIYUN_KYC_PRODUCT || 'ID_PRO',
    SignatureMethod:   'HMAC-SHA1',
    SignatureNonce:    crypto.randomUUID(),
    SignatureVersion:  '1.0',
    Timestamp:         new Date().toISOString(),
    Version:           '2019-03-07',
  };

  const sorted    = Object.keys(params).sort();
  const canonical = sorted.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const toSign    = `GET&${encodeURIComponent('/')}&${encodeURIComponent(canonical)}`;
  const signature = crypto.createHmac('sha1', `${secretKey}&`).update(toSign).digest('base64');
  const url       = `https://cloudauth.aliyuncs.com/?${canonical}&Signature=${encodeURIComponent(signature)}`;

  const resp = await axios.get(url);
  if (!resp.data?.Data?.Passed) throw new Error(resp.data?.Data?.SubCode || '阿里云实名认证失败');
  return { verified: true, provider: 'aliyun_kyc' };
}

// ══════════════════════════════════════════════════════════
// 火山引擎人脸核身
// ══════════════════════════════════════════════════════════
async function verifyViaVolcengineKYC(name, idNumber) {
  // 同上：优先 KYC 专用 AK，回退通用 AK
  const accessKeyId = process.env.VOLC_KYC_ACCESS_KEY_ID     || process.env.VOLCENGINE_ACCESS_KEY_ID;
  const secretKey   = process.env.VOLC_KYC_ACCESS_KEY_SECRET || process.env.VOLCENGINE_ACCESS_KEY_SECRET;

  const host    = 'faceid.volcengineapi.com';
  const service = 'faceid';
  const region  = 'cn-north-1';
  const action  = 'IdCardVerify';
  const version = '2021-11-18';
  const now     = new Date();
  const xDate   = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
  const shortDate = xDate.slice(0, 8);

  const bodyObj = { Name: name, IdCardNumber: idNumber };
  const body    = JSON.stringify(bodyObj);
  const contentHash = crypto.createHash('sha256').update(body).digest('hex');
  const headers = { 'Content-Type': 'application/json', Host: host, 'X-Date': xDate, 'X-Content-Sha256': contentHash };
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k.toLowerCase()}:${headers[k]}`).join('\n') + '\n';
  const signedHeaders    = Object.keys(headers).sort().map(k => k.toLowerCase()).join(';');
  const canonicalRequest = ['POST', '/', `Action=${action}&Version=${version}`, canonicalHeaders, signedHeaders, contentHash].join('\n');
  const credentialScope  = `${shortDate}/${region}/${service}/request`;
  const stringToSign     = ['HMAC-SHA256', xDate, credentialScope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const signingKey    = hmac(hmac(hmac(hmac(secretKey, shortDate), region), service), 'request');
  const signature     = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await axios.post(
    `https://${host}/?Action=${action}&Version=${version}`,
    body,
    { headers: { ...headers, Authorization: authorization } }
  );

  if (resp.data?.ResponseMetadata?.Error) throw new Error(resp.data.ResponseMetadata.Error.Message);
  if (!resp.data?.Result?.Passed) throw new Error('火山引擎实名认证未通过');
  return { verified: true, provider: 'volcengine_kyc' };
}

// ══════════════════════════════════════════════════════════
// 统一 KYC 入口（两种模式）
// ══════════════════════════════════════════════════════════

/**
 * 模式一：会话跳转模式（Didit / Stripe Identity）
 * 返回 redirect_url，前端跳转完成认证，结果通过 Webhook 通知
 * @param {string} userId
 * @param {string} callbackUrl  认证完成后跳转回的 URL
 */
async function createKycSession(userId, callbackUrl) {
  const e        = process.env;
  const strategy = getStrategy('kyc');

  const providers = [
    {
      key:       'kyc_didit',
      available: !!(e.DIDIT_API_KEY && e.DIDIT_WORKFLOW_ID),
      fn:        () => createDiditSession(userId, callbackUrl),
    },
    {
      key:       'kyc_stripe',
      available: !!e.STRIPE_SECRET_KEY,
      fn:        () => createStripeSession(userId, callbackUrl),
    },
  ];

  const available = providers.filter(p => p.available);
  if (!available.length) {
    throw new Error('未配置任何会话型 KYC 服务商（Didit / Stripe Identity）');
  }

  return pollExecute(providers, strategy);
}

/**
 * 模式二：服务端直接认证（阿里云 / 火山引擎）
 * 直接提交姓名 + 身份证号，返回认证结果
 * @param {string} name      真实姓名
 * @param {string} idNumber  身份证号
 */
async function verifyKycDirect(name, idNumber) {
  const e        = process.env;
  const strategy = getStrategy('kyc');

  const providers = [
    {
      key:       'kyc_volcengine',
      available: !!((e.VOLC_KYC_ACCESS_KEY_ID || e.VOLCENGINE_ACCESS_KEY_ID) &&
                    (e.VOLC_KYC_ACCESS_KEY_SECRET || e.VOLCENGINE_ACCESS_KEY_SECRET)),
      fn:        () => verifyViaVolcengineKYC(name, idNumber),
    },
    {
      key:       'kyc_aliyun',
      available: !!((e.ALIYUN_KYC_ACCESS_KEY_ID || e.ALIYUN_ACCESS_KEY_ID) &&
                    (e.ALIYUN_KYC_ACCESS_KEY_SECRET || e.ALIYUN_ACCESS_KEY_SECRET)),
      fn:        () => verifyViaAliyunKYC(name, idNumber),
    },
  ];

  const available = providers.filter(p => p.available);
  if (!available.length) {
    throw new Error('未配置任何直接认证型 KYC 服务商（阿里云 / 火山引擎）');
  }

  return pollExecute(providers, strategy);
}

module.exports = {
  createKycSession,
  verifyKycDirect,
  verifyDiditWebhook,
  verifyStripeWebhook,
};
