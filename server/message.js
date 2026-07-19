/**
 * 消息发送 —— 统一走 QWQ Message 分发中心
 * https://github.com/uesrbai/qwq-message
 *
 * v3.3.3 起，本系统不再直接对接任何短信/邮件服务商。
 * 原来的 sms.js（火山引擎/阿里云/腾讯云）和 email.js（Zeabur Email/SMTP）已删除，
 * 服务商的账号、模板、轮询、故障转移全部由分发中心负责，这边只管调一个接口。
 *
 * 需要配置的环境变量：
 *   QWQ_MESSAGE_URL         分发中心地址，如 https://msg.example.com
 *   QWQ_MESSAGE_KEY         密钥，qwq_live_xxx（生产）或 qwq_test_xxx（测试）
 *   QWQ_MESSAGE_SMS_GROUP   短信通道组标识，如 sms-16
 *   QWQ_MESSAGE_EMAIL_GROUP 邮件通道组标识，如 mail-1
 *   QWQ_MESSAGE_SMS_TEMPLATE  （可选）短信模板号，走模板变量而非纯文本时填
 *
 * ⚠️ 沿用项目既有约定：是否真实发送**不看 NODE_ENV**，
 *    而是看分发中心是否已配置（isConfigured()）。未配置就只打印到控制台。
 */
const { recordCall } = require('./poller');

const PROVIDER_KEY = 'qwq_message';   // 出站调用统计里的标识

/** 分发中心是否已配置到可用状态 */
function isConfigured() {
  return !!(process.env.QWQ_MESSAGE_URL && process.env.QWQ_MESSAGE_KEY);
}

/** 调用分发中心的 /api/v1/send */
async function dispatch(payload) {
  if (!isConfigured()) {
    throw new Error('QWQ Message 未配置（需要 QWQ_MESSAGE_URL 和 QWQ_MESSAGE_KEY）');
  }
  const base = process.env.QWQ_MESSAGE_URL.replace(/\/+$/, '');
  const url  = `${base}/api/v1/send`;

  let res, text;
  try {
    res  = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.QWQ_MESSAGE_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    text = await res.text();
  } catch (e) {
    recordCall(PROVIDER_KEY, false);
    // 网络层失败（DNS/超时/证书），把地址带出来方便排查
    throw new Error(`QWQ Message 请求失败（${url}）：${e.message}`);
  }

  let body;
  try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }

  if (!res.ok || body.success === false) {
    recordCall(PROVIDER_KEY, false);
    const detail = body.detail || body.error || body.message || text || `HTTP ${res.status}`;
    throw new Error(`QWQ Message 发送失败 (${res.status})：${detail}`);
  }

  recordCall(PROVIDER_KEY, true);
  // 分发中心会告诉我们它最终走了哪条通道，记进日志便于对账
  console.log(`[QWQ Message] → ${payload.to || payload.group} via ${body.method || '?'}${body.channelId ? ' #' + body.channelId : ''}`);
  return body;
}

// ──────────────────────────────────────────
// 邮件 HTML 模板（从原 email.js 保留，样式不变）
// ──────────────────────────────────────────
function buildCodeHtml(code) {
  const expire = Math.round(parseInt(process.env.EMAIL_CODE_EXPIRE || '600') / 60);
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
      <div style="text-align:center;margin-bottom:32px;">
        <div style="width:48px;height:48px;background:#5A8A00;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;">
          <span style="color:white;font-size:24px;">🔐</span>
        </div>
        <h1 style="margin:16px 0 4px;font-size:24px;font-weight:700;color:#111827;">登录验证码</h1>
        <p style="margin:0;color:#6B7280;font-size:14px;">统一账号服务</p>
      </div>
      <div style="background:#F6FFDA;border-radius:12px;padding:32px;text-align:center;margin-bottom:24px;border:1px solid #ECFFAF;">
        <p style="margin:0 0 16px;color:#374151;font-size:15px;">您的验证码是：</p>
        <div style="letter-spacing:12px;font-size:40px;font-weight:800;color:#5A8A00;">${code}</div>
        <p style="margin:16px 0 0;color:#9CA3AF;font-size:13px;">验证码 ${expire} 分钟内有效，请勿泄露给他人。</p>
      </div>
      <p style="color:#9CA3AF;font-size:12px;text-align:center;margin:0;">
        如果您未请求此验证码，请忽略此邮件。<br>此邮件由系统自动发送，请勿回复。
      </p>
    </div>`;
}

// ──────────────────────────────────────────
// 对外接口（签名与原 sms.js / email.js 保持一致，调用方无需改动）
// ──────────────────────────────────────────

/**
 * 发送短信。
 * @param {string} phone
 * @param {string} codeOrText 验证码；实名认证提醒场景传的是完整链接，
 *                            由分发中心侧的模板决定怎么填（原行为不变）
 */
async function sendSmsCode(phone, codeOrText) {
  const group = process.env.QWQ_MESSAGE_SMS_GROUP;
  if (!group) throw new Error('QWQ_MESSAGE_SMS_GROUP 未配置，不知道该走哪条短信通道');

  const payload = { group, to: phone, content: String(codeOrText) };

  // 配了模板号就走模板变量，否则发纯文本
  const tpl = process.env.QWQ_MESSAGE_SMS_TEMPLATE;
  if (tpl) {
    payload.templateCode = tpl;
    payload.variables = { code: String(codeOrText) };
  }
  return dispatch(payload);
}

/** 发送邮件（HTML 正文） */
async function sendEmail(to, subject, html) {
  const group = process.env.QWQ_MESSAGE_EMAIL_GROUP;
  if (!group) throw new Error('QWQ_MESSAGE_EMAIL_GROUP 未配置，不知道该走哪条邮件通道');
  return dispatch({ group, to, subject, content: html });
}

/** 发送邮箱验证码（沿用原 HTML 模板） */
async function sendEmailCode(email, code) {
  return sendEmail(email, `【登录验证码】${code}`, buildCodeHtml(code));
}

module.exports = { isConfigured, dispatch, sendSmsCode, sendEmail, sendEmailCode };
