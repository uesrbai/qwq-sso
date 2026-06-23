/**
 * 短信服务 - 支持火山引擎 / 阿里云
 */
const axios = require('axios');
const crypto = require('crypto');

// ============================================================
// 火山引擎短信 (BytePlus SMS)
// 文档: https://www.volcengine.com/docs/6361/67485
// ============================================================
async function sendViaSmsVolcengine(phone, code) {
  const {
    VOLCENGINE_ACCESS_KEY_ID: accessKeyId,
    VOLCENGINE_ACCESS_KEY_SECRET: secretKey,
    VOLCENGINE_SMS_SIGN: smsSign,
    VOLCENGINE_SMS_TEMPLATE_ID: templateId,
  } = process.env;

  const host = 'sms.volcengineapi.com';
  const service = 'sms';
  const region = 'cn-north-1';
  const action = 'SendSms';
  const version = '2020-01-01';
  const now = new Date();

  const xDate = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
  const shortDate = xDate.slice(0, 8);

  const bodyObj = {
    SmsAccount: smsSign,
    Sign: smsSign,
    TemplateID: templateId,
    TemplateParam: JSON.stringify({ code }),
    PhoneNumbers: phone,
  };
  const body = JSON.stringify(bodyObj);
  const contentHash = crypto.createHash('sha256').update(body).digest('hex');

  const headers = {
    'Content-Type': 'application/json',
    'Host': host,
    'X-Date': xDate,
    'X-Content-Sha256': contentHash,
  };

  // 规范请求
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k.toLowerCase()}:${headers[k]}`).join('\n') + '\n';
  const signedHeaders = Object.keys(headers).sort().map(k => k.toLowerCase()).join(';');
  const canonicalRequest = [
    'POST',
    '/',
    `Action=${action}&Version=${version}`,
    canonicalHeaders,
    signedHeaders,
    contentHash,
  ].join('\n');

  // 签名字符串
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

  // 计算签名
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac(secretKey, shortDate), region), service), 'request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await axios.post(
    `https://${host}/?Action=${action}&Version=${version}`,
    body,
    { headers: { ...headers, Authorization: authorization } }
  );

  if (resp.data?.ResponseMetadata?.Error) {
    throw new Error(resp.data.ResponseMetadata.Error.Message || '火山引擎短信发送失败');
  }
  return true;
}

// ============================================================
// 阿里云短信 (Alibaba Cloud SMS)
// 文档: https://help.aliyun.com/document_detail/101414.html
// ============================================================
async function sendViaAliyun(phone, code) {
  const {
    ALIYUN_ACCESS_KEY_ID: accessKeyId,
    ALIYUN_ACCESS_KEY_SECRET: secretKey,
    ALIYUN_SMS_SIGN: signName,
    ALIYUN_SMS_TEMPLATE: templateCode,
  } = process.env;

  const params = {
    AccessKeyId: accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    SignName: signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString(),
    Version: '2017-05-25',
  };

  const sortedKeys = Object.keys(params).sort();
  const canonicalStr = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');

  const stringToSign = `GET&${encodeURIComponent('/')}&${encodeURIComponent(canonicalStr)}`;
  const signature = crypto.createHmac('sha1', `${secretKey}&`).update(stringToSign).digest('base64');

  const url = `https://dysmsapi.aliyuncs.com/?${canonicalStr}&Signature=${encodeURIComponent(signature)}`;
  const resp = await axios.get(url);

  if (resp.data?.Code !== 'OK') {
    throw new Error(resp.data?.Message || '阿里云短信发送失败');
  }
  return true;
}

// ============================================================
// 统一发送接口
// ============================================================
async function sendSmsCode(phone, code) {
  const provider = process.env.SMS_PROVIDER || 'volcengine';

  console.log(`[SMS] 发送验证码 ${code} → ${phone} (via ${provider})`);

  if (provider === 'aliyun') {
    return sendViaAliyun(phone, code);
  }
  return sendViaSmsVolcengine(phone, code);
}

module.exports = { sendSmsCode };
