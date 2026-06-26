/**
 * 短信服务 - 支持火山引擎 / 阿里云 / 腾讯云，带轮询机制
 */
const axios  = require('axios');
const crypto = require('crypto');
const { pollExecute, getStrategy } = require('./poller');

// ============================================================
// 火山引擎短信
// ============================================================
async function sendViaSmsVolcengine(phone, code) {
  const { VOLCENGINE_ACCESS_KEY_ID: accessKeyId, VOLCENGINE_ACCESS_KEY_SECRET: secretKey,
    VOLCENGINE_SMS_SIGN: smsSign, VOLCENGINE_SMS_TEMPLATE_ID: templateId } = process.env;

  const host = 'sms.volcengineapi.com';
  const service = 'sms'; const region = 'cn-north-1';
  const action = 'SendSms'; const version = '2020-01-01';
  const now = new Date();
  const xDate = now.toISOString().replace(/[:-]/g,'').replace(/\.\d{3}/,'');
  const shortDate = xDate.slice(0,8);

  const bodyObj = { SmsAccount: smsSign, Sign: smsSign, TemplateID: templateId,
    TemplateParam: JSON.stringify({ code }), PhoneNumbers: phone };
  const body = JSON.stringify(bodyObj);
  const contentHash = crypto.createHash('sha256').update(body).digest('hex');
  const headers = { 'Content-Type':'application/json', Host:host, 'X-Date':xDate, 'X-Content-Sha256':contentHash };
  const canonicalHeaders = Object.keys(headers).sort().map(k=>`${k.toLowerCase()}:${headers[k]}`).join('\n')+'\n';
  const signedHeaders = Object.keys(headers).sort().map(k=>k.toLowerCase()).join(';');
  const canonicalRequest = ['POST','/',`Action=${action}&Version=${version}`,canonicalHeaders,signedHeaders,contentHash].join('\n');
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256',xDate,credentialScope,crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const hmac = (key, data) => crypto.createHmac('sha256',key).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac(secretKey,shortDate),region),service),'request');
  const signature = crypto.createHmac('sha256',signingKey).update(stringToSign).digest('hex');
  const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await axios.post(`https://${host}/?Action=${action}&Version=${version}`, body,
    { headers: { ...headers, Authorization: authorization } });
  if (resp.data?.ResponseMetadata?.Error) throw new Error(resp.data.ResponseMetadata.Error.Message);
  return true;
}

// ============================================================
// 阿里云短信
// ============================================================
async function sendViaAliyun(phone, code) {
  const { ALIYUN_ACCESS_KEY_ID: accessKeyId, ALIYUN_ACCESS_KEY_SECRET: secretKey,
    ALIYUN_SMS_SIGN: signName, ALIYUN_SMS_TEMPLATE: templateCode } = process.env;

  const params = { AccessKeyId:accessKeyId, Action:'SendSms', Format:'JSON', PhoneNumbers:phone,
    SignName:signName, SignatureMethod:'HMAC-SHA1', SignatureNonce:crypto.randomUUID(),
    SignatureVersion:'1.0', TemplateCode:templateCode, TemplateParam:JSON.stringify({code}),
    Timestamp:new Date().toISOString(), Version:'2017-05-25' };
  const sortedKeys = Object.keys(params).sort();
  const canonicalStr = sortedKeys.map(k=>`${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const stringToSign = `GET&${encodeURIComponent('/')}&${encodeURIComponent(canonicalStr)}`;
  const signature = crypto.createHmac('sha1',`${secretKey}&`).update(stringToSign).digest('base64');
  const url = `https://dysmsapi.aliyuncs.com/?${canonicalStr}&Signature=${encodeURIComponent(signature)}`;
  const resp = await axios.get(url);
  if (resp.data?.Code !== 'OK') throw new Error(resp.data?.Message || '阿里云短信失败');
  return true;
}

// ============================================================
// 腾讯云短信
// ============================================================
async function sendViaTencent(phone, code) {
  const { TENCENT_SECRET_ID: secretId, TENCENT_SECRET_KEY: secretKey,
    TENCENT_SMS_APP_ID: appId, TENCENT_SMS_SIGN: signName,
    TENCENT_SMS_TEMPLATE_ID: templateId } = process.env;

  const endpoint = 'sms.tencentcloudapi.com';
  const service  = 'sms';
  const action   = 'SendSms';
  const version  = '2021-01-11';
  const now      = Math.floor(Date.now() / 1000);
  const date     = new Date(now * 1000).toISOString().slice(0, 10);

  const payload = JSON.stringify({
    SmsSdkAppId: appId, SignName: signName, TemplateId: templateId,
    TemplateParamSet: [code], PhoneNumberSet: [`+86${phone}`],
  });

  const hashedPayload = crypto.createHash('sha256').update(payload).digest('hex');
  const canonicalRequest = ['POST', '/', '', 'content-type:application/json\nhost:' + endpoint + '\n',
    'content-type;host', hashedPayload].join('\n');
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(now), credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

  const hmac = (key, data, enc) => crypto.createHmac('sha256', key).update(data).digest(enc);
  const secretDate    = hmac('TC3' + secretKey, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature     = hmac(secretSigning, stringToSign, 'hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signature}`;

  const resp = await axios.post(`https://${endpoint}`, payload, {
    headers: {
      'Content-Type': 'application/json',
      Host: endpoint,
      Authorization: authorization,
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Timestamp': String(now),
    },
  });

  const result = resp.data?.Response;
  if (result?.Error) throw new Error(result.Error.Message || '腾讯云短信失败');
  if (result?.SendStatusSet?.[0]?.Code !== 'Ok') throw new Error(result?.SendStatusSet?.[0]?.Message || '腾讯云短信失败');
  return true;
}

// ============================================================
// 统一发送接口（轮询）
// ============================================================
async function sendSmsCode(phone, code) {
  const e = process.env;
  const strategy = getStrategy('sms');

  // 按配置检测哪些服务商可用
  const providers = [
    {
      key:       'sms_volcengine',
      available: !!(e.VOLCENGINE_ACCESS_KEY_ID && e.VOLCENGINE_SMS_TEMPLATE_ID),
      fn:        () => sendViaSmsVolcengine(phone, code),
    },
    {
      key:       'sms_aliyun',
      available: !!(e.ALIYUN_ACCESS_KEY_ID && e.ALIYUN_SMS_TEMPLATE),
      fn:        () => sendViaAliyun(phone, code),
    },
    {
      key:       'sms_tencent',
      available: !!(e.TENCENT_SECRET_ID && e.TENCENT_SMS_TEMPLATE_ID),
      fn:        () => sendViaTencent(phone, code),
    },
  ];

  const available = providers.filter(p => p.available);
  if (!available.length) throw new Error('未配置任何短信服务商，请在环境变量中填写相关参数');

  const { provider } = await pollExecute(providers, strategy);
  console.log(`[SMS] ${phone} ← ${provider} (strategy:${strategy})`);
}

module.exports = { sendSmsCode };
